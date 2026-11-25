"""Print a keyring JSON (RS256). New ring:   python scripts/gen_keyring.py > keyring.json
Rotate (add a key, make it active, keep old ones for verification):   python scripts/gen_keyring.py --rotate keyring.json > new.json
Retire an old key later by deleting it from the file once its tokens have expired (access tokens: 15 min; support: 30 min)."""
import json
import sys

sys.path.insert(0, ".")
from app.core.security import generate_key  # noqa: E402

if len(sys.argv) == 3 and sys.argv[1] == "--rotate":
    ring = json.load(open(sys.argv[2]))
    new = generate_key()
    ring["keys"].insert(0, new)
    ring["active_kid"] = new["kid"]
else:
    k = generate_key()
    ring = {"active_kid": k["kid"], "keys": [k]}
print(json.dumps(ring, indent=2))
