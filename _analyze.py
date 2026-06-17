import os, numpy as np
from PIL import Image
from scipy import ndimage

d = 'arena-game/assets/menu'
im = Image.open(os.path.join(d, 'new_menu.png')).convert('RGB')
a = np.asarray(im).astype(np.int32)
r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
mx = a.max(axis=2); mn = a.min(axis=2)
neutral = (mx - mn) < 22
bright = mx > 198
bg_color = neutral & bright

# фон = нейтрально-светлые области, связанные с краем
lbl, n = ndimage.label(bg_color)
border = set(np.unique(np.concatenate([lbl[0, :], lbl[-1, :], lbl[:, 0], lbl[:, -1]])))
border.discard(0)
bg = np.isin(lbl, list(border))
fg = ~bg
fg = ndimage.binary_fill_holes(fg)

flbl, fn = ndimage.label(fg)
print('foreground components:', fn)
objs = ndimage.find_objects(flbl)
H, W = fg.shape
items = []
for i, sl in enumerate(objs, start=1):
    ys, xs = sl
    area = int((flbl[sl] == i).sum())
    if area < 1500:
        continue
    cy = (ys.start + ys.stop) / 2 / H
    cx = (xs.start + xs.stop) / 2 / W
    items.append((round(cx, 3), round(cy, 3), xs.start, ys.start, xs.stop, ys.stop, area))
items.sort(key=lambda t: (round(t[1] * 3), t[0]))
for it in items:
    print(it)
print('kept:', len(items))
