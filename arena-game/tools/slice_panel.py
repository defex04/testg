"""Нарезать panel_hit.png на 3 спрайта с прозрачным фоном.

Исходник — лист на белом фоне: колесо (сверху, во всю ширину),
щит (снизу слева), меч (снизу справа). Скрипт находит три объекта,
делает фон прозрачным (мягкая альфа по светлоте) и сохраняет
wheel.png / shield.png / sword.png рядом с исходником.
"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage

SRC = os.path.join('arena-game', 'assets', 'fight', 'panel_hit.png')
OUT = os.path.dirname(SRC)

LUM_HI = 236   # светлее этого — чистый фон (альфа 0)
SOFT = 46      # ширина перехода фон→объект
PAD = 8        # запас вокруг объекта, px

im = Image.open(SRC).convert('RGBA')
data = np.asarray(im)
H, W = data.shape[:2]
alpha = data[:, :, 3]

# объекты ищем по непрозрачным пикселям; небольшое замыкание, чтобы
# тонкие спицы/крестовина меча не дробились на куски
solid = alpha > 24
solid = ndimage.binary_closing(solid, iterations=2)
lbl, n = ndimage.label(solid)
boxes = []
for i, sl in enumerate(ndimage.find_objects(lbl), start=1):
    if sl is None:
        continue
    area = int((lbl[sl] == i).sum())
    if area < 1500:
        continue
    ys, xs = sl
    boxes.append([xs.start, ys.start, xs.stop, ys.stop, area,
                  (ys.start + ys.stop) / 2, (xs.start + xs.stop) / 2, i])

# сверху вниз, затем слева направо
boxes.sort(key=lambda b: (round(b[5] / 80), b[6]))
names = ['wheel', 'shield', 'sword']
print(f'image {W}x{H}, components kept: {len(boxes)}')

for name, b in zip(names, boxes):
    x0, y0, x1, y1 = b[:4]
    x0 = max(0, x0 - PAD); y0 = max(0, y0 - PAD)
    x1 = min(W, x1 + PAD); y1 = min(H, y1 + PAD)
    # маска только этого объекта (с запасом, чтобы сохранить мягкие края)
    own = ndimage.binary_dilation(lbl == b[7], iterations=PAD + 2)
    out = data[y0:y1, x0:x1].copy()
    out[:, :, 3] = (out[:, :, 3] * own[y0:y1, x0:x1]).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(os.path.join(OUT, name + '.png'))
    print(f'{name}.png  {x1 - x0}x{y1 - y0}  bbox=({x0},{y0},{x1},{y1})  area={b[4]}')
