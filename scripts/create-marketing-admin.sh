#!/usr/bin/env bash
# Create the first partner-portal admin (marketing-service). Prompts; password never on the command line.
# Non-interactive (tests): CHILLI_ADMIN_EMAIL, CHILLI_ADMIN_NAME, CHILLI_ADMIN_PASSWORD.
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
[ -n "$(our_container marketing-service)" ] || die "marketing-service is not running (scripts/deploy.sh first)"
email=${CHILLI_ADMIN_EMAIL:-}; name=${CHILLI_ADMIN_NAME:-}; pw=${CHILLI_ADMIN_PASSWORD:-}
[ -n "$email" ] || read -r -p "Partner admin e-mail: " email
[ -n "$name" ] || read -r -p "Full name: " name
if [ -z "$pw" ]; then
  read -r -s -p "Password (10+ characters): " pw; echo
  read -r -s -p "Repeat password: " pw2; echo; [ "$pw" = "$pw2" ] || die "passwords differ"
fi
export PW="$pw" E="$email" N="$name"
dc exec -T -e PW -e E -e N marketing-service python -c \
  'import os,sys,runpy; sys.path.insert(0,"."); sys.argv=["create_admin.py",os.environ["E"],os.environ["N"],os.environ["PW"]]; runpy.run_path("scripts/create_admin.py", run_name="__main__")'
echo "Sign in at https://$(envget DOMAIN_PARTNER)$(envget PUBLIC_PORT_SUFFIX) as $email, then add salespeople / onboarding agents under Team."
