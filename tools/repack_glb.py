"""Repack fighter GLB: embed extracted textures as binary bufferViews
instead of broken external URIs."""
import json
import struct
import os

SRC = r"C:\Users\andre\Downloads\new\Bouncing Fight Idle (1).glb"
TEX_DIR = r"C:\Users\andre\Downloads\new\tools\extracted"
OUT = r"C:\Users\andre\Downloads\new\arena-game\assets\models\fighter.glb"
os.makedirs(os.path.dirname(OUT), exist_ok=True)

with open(SRC, "rb") as f:
    magic, version, total = struct.unpack("<III", f.read(12))
    jlen, jtype = struct.unpack("<II", f.read(8))
    gltf = json.loads(f.read(jlen))
    blen, btype = struct.unpack("<II", f.read(8))
    binchunk = bytearray(f.read(blen))

def pad4(buf, fill=b"\x00"):
    while len(buf) % 4:
        buf.extend(fill)

bufferviews = gltf["bufferViews"]
for img in gltf["images"]:
    uri = img.pop("uri")
    base = os.path.basename(uri)
    tex_path = os.path.join(TEX_DIR, base)
    blob = open(tex_path, "rb").read()
    pad4(binchunk)
    offset = len(binchunk)
    binchunk.extend(blob)
    bufferviews.append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob)})
    img["bufferView"] = len(bufferviews) - 1
    img["mimeType"] = "image/jpeg"
    img["name"] = base
    print("embedded", base, len(blob), "bytes at", offset)

pad4(binchunk)
gltf["buffers"][0]["byteLength"] = len(binchunk)

jbytes = bytearray(json.dumps(gltf, separators=(",", ":")).encode("utf8"))
pad4(jbytes, b" ")

total = 12 + 8 + len(jbytes) + 8 + len(binchunk)
with open(OUT, "wb") as f:
    f.write(struct.pack("<III", 0x46546C67, 2, total))
    f.write(struct.pack("<II", len(jbytes), 0x4E4F534A))
    f.write(jbytes)
    f.write(struct.pack("<II", len(binchunk), 0x004E4942))
    f.write(binchunk)

print("written", OUT, total, "bytes")
