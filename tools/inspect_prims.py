import json, struct

def load(path):
    with open(path, "rb") as f:
        f.read(12)
        clen, ctype = struct.unpack("<II", f.read(8))
        return json.loads(f.read(clen))

g = load(r"C:\Users\andre\Downloads\new\arena-game\assets\models\fighter.glb")
for mi, mesh in enumerate(g["meshes"]):
    for pi, p in enumerate(mesh["primitives"]):
        print("mesh", mi, "prim", pi, "attrs:", list(p["attributes"].keys()))
        for k, v in p["attributes"].items():
            acc = g["accessors"][v]
            print("   ", k, acc["type"], acc.get("count"))
