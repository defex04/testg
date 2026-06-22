import { WebSocketServer } from 'ws';
import { sessionByToken } from './auth.js';
import { getCharacter } from './characters.js';
import { enterLocation, leavePresence } from './locations.js';
import * as battle from './battle/manager.js';
import { sendChat, sendPersonal, sendPrivate, subscribeChat, subscribePrivate } from './chat.js';
import { redis, redisSub } from './db.js';

const MAIL_NOTIFY = (id) => `mail.notify.${id}`;
const configuredPresenceGrace = Number(process.env.PRESENCE_GRACE_MS);
const PRESENCE_GRACE_MS = Number.isFinite(configuredPresenceGrace) ? configuredPresenceGrace : 0;

/**
 * Один WebSocket на клиента: бой + чат + присутствие.
 * Закрытие сокета бой НЕ прерывает: менеджер продолжает ходы,
 * при следующем подключении бой возвращается сообщением battleResume.
 */
export function createHub(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const byChar = new Map();

  async function forgetPresence(ch, conn) {
    if (byChar.get(String(ch.id)) !== conn) return;
    byChar.delete(String(ch.id));
    battle.detach(ch.id);
    const me = await getCharacter(ch.id);
    await leavePresence(me).catch(() => {});
  }

  subscribeChat((msg) => {
    const out = JSON.stringify({ type: 'chat', from: msg.senderName,
      fromId: msg.senderId ?? null, text: msg.body, ts: msg.ts ?? Date.now(),
      to: msg.toName ?? null, toId: msg.toId ?? null });
    for (const conn of byChar.values()) {
      if (conn.locId === msg.locId && conn.ws.readyState === 1) conn.ws.send(out);
    }
  });

  // личка: сообщение адресовано конкретному зрителю (viewerId), шлём только ему
  subscribePrivate((msg) => {
    const conn = byChar.get(String(msg.viewerId));
    if (!conn || conn.ws.readyState !== 1) return;
    const mine = String(msg.fromId) === String(msg.viewerId);
    conn.send({ type: 'chatDM',
      peerId: mine ? msg.toId : msg.fromId,
      peerName: mine ? msg.toName : msg.fromName,
      text: msg.body, ts: msg.ts, mine });
  });

  // почта: пинг адресату — обновить счётчик непрочитанных (доходит между процессами)
  redisSub.pSubscribe('mail.notify.*', (raw) => {
    let id; try { id = JSON.parse(raw).to; } catch { return; }
    const conn = byChar.get(String(id));
    if (conn && conn.ws.readyState === 1) conn.send({ type: 'mail', event: 'new' });
  });

  wss.on('connection', async (ws, req) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    const session = await sessionByToken(token);
    if (!session) return ws.close(4401, 'unauthorized');
    const ch = await getCharacter(session.character_id);

    const prev = byChar.get(String(ch.id));
    if (prev?.offlineTimer) clearTimeout(prev.offlineTimer);
    if (prev && prev.ws.readyState === 1) prev.ws.close(4000, 'replaced'); // вторая вкладка

    const send = (o) => { try {
      if (ws.readyState === 1) ws.send(JSON.stringify(o));
    } catch { /* сокет умер — бой продолжается без зрителя */ } };
    const conn = { ws, locId: ch.location_id, send, intentionalClose: false,
      offlineTimer: null };
    byChar.set(String(ch.id), conn);
    await enterLocation(ch);

    send({ type: 'hello', character: ch });
    const resume = battle.attach(ch.id, send);   // идущий бой возвращается после F5
    if (resume) send(resume);

    ws.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      try {
        switch (m.type) {
          case 'hunt': {
            const me = await getCharacter(ch.id);
            await battle.startHunt(me, send);
            break;
          }
          case 'attack': {        // дуэль PvP: нападение на игрока локации
            const targetId = String(m.targetId || '');
            if (!targetId || targetId === String(ch.id)) {
              throw new Error('cannot_attack_self');
            }
            const target = byChar.get(targetId);
            const me = await getCharacter(ch.id);
            const targetCh = await getCharacter(targetId);
            if (!target || target.ws.readyState !== 1 || !targetCh) {
              if (target && targetCh) await forgetPresence(targetCh, target);
              throw new Error('target_offline');
            }
            await battle.startDuel(me, targetCh, send, target.send);
            break;
          }
          case 'join': {       // вмешательство: войти в идущий бой на сторону
            await battle.joinBattle(ch.id, Number(m.battleId), m.side, send);
            break;
          }
          case 'move':     battle.submitMove(ch.id, m); break;
          case 'elixir':   await battle.useElixir(ch.id, m); break;
          case 'turnDone': await battle.finishTurn(ch.id); break;
          case 'escape':   await battle.escapeBattle(ch.id); break;
          case 'leaveBattle': battle.leaveBattle(ch.id); break;  // бросит cannot_leave
          case 'clientClose':
            conn.intentionalClose = true;
            ws.close(1000, 'client_close');
            break;
          case 'chat': {
            const me = await getCharacter(ch.id);
            await sendChat(me, m.text);
            break;
          }
          case 'chatPersonal': {     // личное сообщение в общий чат локации
            const me = await getCharacter(ch.id);
            await sendPersonal(me, m.to, m.text);
            break;
          }
          case 'chatPrivate': {      // приватное сообщение (личка) в отдельный канал
            const me = await getCharacter(ch.id);
            await sendPrivate(me, m.to, m.text);
            break;
          }
        }
      } catch (e) {
        const payload = { type: 'error', error: e.message };
        for (const k of ['battleId', 'targetSide', 'allowJoin']) {
          if (e[k] != null) payload[k] = e[k];
        }
        send(payload);
      }
    });

    ws.on('close', async () => {
      if (byChar.get(String(ch.id)) === conn) {
        battle.detach(ch.id);                    // НЕ прерываем бой
        if (conn.intentionalClose) {
          await forgetPresence(ch, conn);
        } else if (PRESENCE_GRACE_MS > 0) {
          conn.offlineTimer = setTimeout(() => {
            forgetPresence(ch, conn).catch(() => {});
          }, PRESENCE_GRACE_MS);
        } else {
          await forgetPresence(ch, conn);
        }
      }
    });
  });

  return {
    onMoved(charId, from, to) {
      const conn = byChar.get(String(charId));
      if (conn) conn.locId = to;
    },
    /** Уведомить адресата о новом письме (через redis — между процессами). */
    notifyMail(recipientId) {
      redis.publish(MAIL_NOTIFY(recipientId),
        JSON.stringify({ to: Number(recipientId) })).catch(() => {});
    },
  };
}
