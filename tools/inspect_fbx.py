"""Quick structural dump of a binary FBX: objects, geometry, deformers, textures."""
import struct
import sys

path = sys.argv[1]
data = open(path, "rb").read()
print("size:", len(data), "magic:", data[:20])

# count key node types by scanning for type names
for marker in (b"Geometry", b"Deformer", b"Model", b"Video", b"Texture", b"Material",
               b"AnimationCurve", b"Skin", b"Cluster"):
    print(marker.decode(), data.count(marker))

# embedded media
idx = 0
print("--- embedded content blobs ---")
while True:
    idx = data.find(b"Content", idx)
    if idx < 0:
        break
    pos = idx + 7
    if pos < len(data) and data[pos:pos + 1] == b"R":
        blen = struct.unpack("<I", data[pos + 1:pos + 5])[0]
        rfi = data.rfind(b"RelativeFilename", 0, idx)
        name = "?"
        if rfi > 0:
            p = rfi + len(b"RelativeFilename")
            if data[p:p + 1] == b"S":
                slen = struct.unpack("<I", data[p + 1:p + 5])[0]
                name = data[p + 5:p + 5 + slen].decode("utf8", "replace")
        print("  ", name, blen, "bytes")
    idx += 7

# vertex count: find Vertices node, type 'd' (double array) or 'f'
vi = data.find(b"Vertices")
if vi > 0:
    p = vi + 8
    t = data[p:p + 1]
    if t in (b"d", b"f"):
        alen, enc, clen = struct.unpack("<III", data[p + 1:p + 13])
        print("Vertices: array len", alen, "type", t, "-> verts:", alen // 3, "encoded:", enc)
