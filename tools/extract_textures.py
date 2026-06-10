"""Extract embedded texture blobs from a binary FBX (Video/Content nodes)."""
import struct
import sys
import os

path = r"C:\Users\andre\Downloads\new\Bouncing Fight Idle (1).fbx"
out_dir = r"C:\Users\andre\Downloads\new\tools\extracted"
os.makedirs(out_dir, exist_ok=True)

data = open(path, "rb").read()
print("FBX magic:", data[:20])

results = []
idx = 0
while True:
    idx = data.find(b"Content", idx)
    if idx < 0:
        break
    pos = idx + 7
    if pos < len(data) and data[pos:pos + 1] == b"R":
        blen = struct.unpack("<I", data[pos + 1:pos + 5])[0]
        blob = data[pos + 5:pos + 5 + blen]
        # find preceding RelativeFilename string property
        rfi = data.rfind(b"RelativeFilename", 0, idx)
        name = "unknown_%d" % idx
        if rfi > 0:
            p = rfi + len(b"RelativeFilename")
            if data[p:p + 1] == b"S":
                slen = struct.unpack("<I", data[p + 1:p + 5])[0]
                name = data[p + 5:p + 5 + slen].decode("utf8", "replace")
        results.append((idx, name, blob))
    idx += 7

for pos, name, blob in results:
    base = os.path.basename(name.replace("\\", "/"))
    out = os.path.join(out_dir, base)
    with open(out, "wb") as f:
        f.write(blob)
    print("pos", pos, "| file:", base, "| size:", len(blob), "| sig:", blob[:4])
