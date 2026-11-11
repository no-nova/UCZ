#!/usr/bin/env python3
"""Compare the P15 seed-1 rand() low-byte generator with this host's native libc."""
import ctypes, hashlib, json, platform
from pathlib import Path
n = 262144
r = [0] * (n + 344)
r[0] = 1
for i in range(1, 31):
    r[i] = (16807 * r[i - 1]) % 2147483647
r[31:34] = r[:3]
for i in range(34, len(r)):
    r[i] = (r[i - 31] + r[i - 3]) & 0xffffffff
synthetic = bytes((r[344+i] >> 1) & 255 for i in range(n))
libc = ctypes.CDLL(None)
libc.srand.argtypes = [ctypes.c_uint]
libc.rand.restype = ctypes.c_int
libc.srand(1)
native = bytes(libc.rand() & 255 for _ in range(n))
h = lambda x: hashlib.sha256(x).hexdigest()
receipt = json.loads(Path('scripts/diag/p15-results/unit4/synthetic-glibc-low8--endpoint--262144-0--main.json').read_text())
assert synthetic == native and h(synthetic) == receipt['result']['input']['sha256']
print(json.dumps({'status':'PASS','count':n,'seed':1,'interpretation':'low 8 bits of each native rand() return','libc':platform.libc_ver(),'sha256':h(native),'matches_archived_endpoint_input':True}))
