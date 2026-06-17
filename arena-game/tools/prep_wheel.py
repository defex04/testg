"""Подготовить wheel.webp из wheel2.png: обрезать в квадрат с кругом ТОЧНО по
центру холста. Иначе обод/таймер «уезжают» (исходник смещён по вертикали).

Геометрия итогового круга (доли половины холста), на них опирается BattleUI:
  ступица r≈0.28, внутр. край обода r≈0.74, внешний ≈0.875, шипы ≈1.0
  → viewBox: RI≈14, RO≈37, кольцо-таймера ≈40 (из 100).
Спицы стоят неравномерно (≈32.5/90/147/214/270/326°) — эти углы заданы в
BattleUI (SECTORS), чтобы заливка ложилась точно по спицам.
"""
import math
import numpy as np
from PIL import Image

SRC = 'arena-game/assets/fight/wheel2.png'
OUT = 'arena-game/assets/fight/wheel.webp'
MARGIN = 6

im = Image.open(SRC).convert('RGBA')
A = np.asarray(im)[:, :, 3]
ys, xs = np.where(A > 100)
cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2   # центр содержимого
ex = max(cx - xs.min(), xs.max() - cx)
ey = max(cy - ys.min(), ys.max() - cy)
half = int(math.ceil(max(ex, ey))) + MARGIN

crop = im.crop((int(cx) - half, int(cy) - half, int(cx) + half, int(cy) + half))
crop.save(OUT, 'WEBP', quality=88, method=6)
print(f'wheel.webp {crop.size}, circle centered (src center {cx:.0f},{cy:.0f})')
