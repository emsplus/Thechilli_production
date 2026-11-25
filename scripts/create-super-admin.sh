#!/usr/bin/env bash
# Create the first Super Admin (platform-core). Prompts for e-mail, name and password (password never on the command line).
# Non-interactive (tests): CHILLI_ADMIN_EMAIL, CHILLI_ADMIN_NAME, CHILLI_ADMIN_PASSWORD in the environment.
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
[ -n "$(our_container platform-core)" ] || die "platform-core is not running (scripts/deploy.sh first)"
email=${CHILLI_ADMIN_EMAIL:-}; name=${CHILLI_ADMIN_NAME:-}; pw=${CHILLI_ADMIN_PASSWORD:-}
[ -n "$email" ] || read -r -p "Super Admin e-mail: " email
[ -n "$name" ] || read -r -p "Full name: " name
if [ -z "$pw" ]; then
  read -r -s -p "Password (12+ characters, not containing your name/e-mail): " pw; echo
  read -r -s -p "Repeat password: " pw2; echo; [ "$pw" = "$pw2" ] || die "passwords differ"
fi
export PW="$pw"
printf '%s\n' 'import os,sys,getpass' 'sys.path.insert(0,".")' 'getpass.getpass=lambda p="":os.environ["PW"]' \
  "sys.argv=['create_super_admin.py', os.environ['E'], os.environ['N']]" 'exec(open("scripts/create_super_admin.py").read())' \
  | E="$email" N="$name" dc exec -T -e PW -e E -e N platform-core python -
cat <<TXT

Next: open https://$(envget DOMAIN_ADMIN)$(envget PUBLIC_PORT_SUFFIX) and sign in as $email.
  The first sign-in asks you to set up an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password...):
  scan the QR code (or type the setup key), enter the 6-digit code, and SAVE THE RECOVERY CODES offline.
  Money actions (credit, plan prices, entitlements, staff) ask for a fresh code again ("Confirm with your code").
TXT
