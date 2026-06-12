import { WebSocketServer } from 'ws';
import { sessionByToken } from './auth.js';
import { getCharacter } from './characters.js';
import { enterLocation, leavePresence } from './locations.js';
import * as battle from './battle/manager.js';
import { sendChat, subscribeChat } from './chat.js';

/**
 * Один WebSocket на клиента: бой + чат + присутствие.
 * Закрытие сокета бой НЕ прерывает: менеджер продолжает ходы,
 * при следующем подключении бой возвращается сообщением battleResume.
 */
export function createHub(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const byChar = new Map();

  subscribeChat((msg) => {
    for (const conn of byChar.values()) {
      if (conn.locId === msg.locId && conn.ws.readyState === 1) {
        conn.ws.send(JSON.stringify({ type: 'chat', from: msg.senderName, text: msg.body }));
      }
    }
  });

  wss.on('connection', async (ws, req) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    const session = await sessionByToken(token);
    if (!session) return ws.close(4401, 'unauthorized');
    const ch = await getCharacter(session.character_id);

    const prev = byChar.get(String(ch.id));
    if (prev && prev.ws.readyState === 1) prev.ws.close(4000, 'replaced'); // вторая вкладка

    const send = (o) => { try {
      if (ws.readyState === 1) ws.send(JSON.stringify(o));
    } catch { /* сокет умер — бой продолжается без зрителя */ } };
    const conn = { ws, locId: ch.location_id, send };
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
            if (!target) throw new Error('target_offline');
            const me = await getCharacter(ch.id);
            const targetCh = await getCharacter(targetId);
            if (!targetCh) throw new Error('target_offline');
            await battle.startDuel(me, targetCh, send, target.send);
            break;
          }
          case 'move':     battle.submitMove(ch.id, m); break;
          case 'turnDone': await battle.finishTurn(ch.id); break;
          case 'escape':   await battle.escapeBattle(ch.id); break;
          case 'leaveBattle': battle.leaveBattle(ch.id); break;  // бросит cannot_leave
          case 'chat': {
            const me = await getCharacter(ch.id);
            await sendChat(me, m.text);
            break;
          }
        }
      } catch (e) {
        send({ type: 'error', error: e.message });
      }
    });

    ws.on('close', async () => {
      if (byChar.get(String(ch.id)) === conn) {
        byChar.delete(String(ch.id));
        battle.detach(ch.id);                    // НЕ прерываем бой
        const me = await getCharacter(ch.id);
        await leavePresence(me).catch(() => {});
      }
    });
  });

  return {
    onMoved(charId, from, to) {
      const conn = byChar.get(String(charId));
      if (conn) conn.locId = to;
    },
  };
}
