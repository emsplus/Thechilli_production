#!/usr/bin/env bash
# INR-only guard (docs/INR_ONLY.md, docs/DECISIONS.md 2026-10-31).
#
# Fails when a foreign currency, a non-India locale/timezone/country or a
# UK/UAE tax term appears in any tracked (or new, not ignored) text file of
# this repo: code, tests, docs, fixtures, seed data, templates, CSS.
#
# Usage:
#   scripts/check-inr-only.sh            # scan this repo, exit 1 on a hit
#   scripts/check-inr-only.sh --count    # print only the number of hits
#   scripts/check-inr-only.sh DIR        # scan another directory (no git needed)
#
# Allowlist: scripts/inr-only-allowlist.txt, one entry per line:
#   <path glob>                    the whole file is exempt (keep this rare)
#   <path glob> :: <perl regex>    only lines in that file matching the regex
# Every entry needs a "# why" comment on the line above it.
set -euo pipefail

count_only=0
root=""
for arg in "$@"; do
  case "$arg" in
    --count) count_only=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) root="$arg" ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$root" ]; then
  root="$(dirname "$script_dir")" # this app only (the repo may be a monorepo with other services)
fi
cd "$root"
allowlist="$script_dir/inr-only-allowlist.txt"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  list_files() { git ls-files -z --cached --others --exclude-standard; }
else
  list_files() { find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.venv/*' -print0 | perl -0pe "s{^\./}{}"; }
fi

list_files | COUNT_ONLY="$count_only" ALLOWLIST="$allowlist" perl -0ne '
  BEGIN {
    # Generated, vendored or binary-ish files never hold our money strings.
    @skip = (
      qr{(^|/)scripts/check-inr-only\.sh$}, qr{(^|/)scripts/inr-only-allowlist\.txt$},
      qr{(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|Gemfile\.lock)$},
      qr{(^|/)(node_modules|\.venv|venv|dist|build|\.next|coverage|playwright-report|test-results|__pycache__)/},
      qr{\.(png|jpe?g|gif|webp|ico|icns|pdf|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|zip|gz|jar|keystore|so|dylib|bin|pyc)$}i,
      qr{\.min\.(js|css)$},
      qr{(^|/)(android|ios)/.*\.(gradle|xcodeproj|pbxproj|plist|xml)$},
    );
    # name => pattern. Case-sensitive unless (?i).
    @rules = (
      [ "currency-code", qr{\b(USD|EUR|GBP|AED|JPY|AUD|CAD|SGD|SAR|CNY|CHF)\b} ],
      [ "currency-symbol", qr{(\x{00A3}|\x{20AC}|\x{00A5}|US\$|\x{062F}\.\x{0625}|\bDirhams?\b|\bdirhams?\b|\bfils\b)} ],
      [ "dollar-amount", qr{(?<![\w\{\\\$])\$ ?\d[\d,]*\.\d\d\b} ],
      [ "currency-word", qr{(?i)\b(us dollars?|euros?|pounds? sterling|sterling|pence|(?<!per )cents?|pound sign)\b} ],
      [ "foreign-currency-value", qr{(?i)currency\w*["\x27]?\s*(?:[:=]|==|!=|\bis\b)\s*["\x27](?!INR["\x27])[A-Z]{3}["\x27]} ],
      [ "foreign-locale", qr{\b(en[-_](GB|US|AE|AU)|ar[-_]AE)\b} ],
      [ "foreign-timezone", qr{(Europe/London|Asia/Dubai|America/New_York|America/Los_Angeles)} ],
      [ "foreign-country", qr{(United Kingdom|United Arab Emirates|\bUAE\b|\bDubai\b|Abu Dhabi|\bU\.K\.|["\x27](GB|AE|UK|US)["\x27])} ],
      [ "uk-uae-tax", qr{(\bHMRC\b|\bTRN\b|\bFTA\b|\bVAT\b|\bvat[-_]summary\b|ALLOW_LEGACY_COUNTRIES|(?i)allow_legacy_countries)} ],
      [ "uk-uae-name", qr{(?i)\b\w*(?:uk|uae)_?(?:vat|defaults?|setup|restaurant|rules?)\w*\b|\bswitch_?to_?uk\b|\btrn_?(?:ae|gb|uk|uae)\b} ],
      [ "rs-literal", qr{(["\x27`]Rs\.?\s*["\x27`\$]|\bRs\.?\s?\d)} ],
    );
    %allow_file = (); @allow_line = ();
    if (open my $fh, "<:encoding(UTF-8)", $ENV{ALLOWLIST}) {
      local $/ = "\n";
      while (my $l = <$fh>) {
        chomp $l; $l =~ s/^\s+|\s+$//g;
        next if $l eq "" || $l =~ /^#/;
        my ($g, $re) = split /\s+::\s+/, $l, 2;
        (my $rx = quotemeta $g) =~ s/\\\*\\\*/.*/g; $rx =~ s/\\\*/[^\/]*/g; $rx =~ s/\\\?/./g;
        if (defined $re) { push @allow_line, [qr{^$rx$}, qr{$re}] } else { $allow_file{$g} = qr{^$rx$} }
      }
    }
    $hits = 0;
  }
  chomp(my $f = $_);
  next if $f eq "";
  next if grep { $f =~ $_ } @skip;
  next if grep { $f =~ $_ } values %allow_file;
  next unless -f $f && -T $f;
  my @lre = map { $_->[1] } grep { $f =~ $_->[0] } @allow_line;
  open my $in, "<:encoding(UTF-8)", $f or next;
  local $/ = "\n";
  while (my $line = <$in>) {
    for my $r (@rules) {
      my ($name, $re) = @$r;
      next unless $line =~ $re;
      next if grep { $line =~ $_ } @lre;
      $hits++;
      unless ($ENV{COUNT_ONLY}) { (my $t = $line) =~ s/\s+$//; $t = substr($t, 0, 160); binmode STDOUT, ":encoding(UTF-8)"; print "$f:$.: [$name] $t\n"; }
      last;
    }
  }
  close $in;
  END {
    if ($ENV{COUNT_ONLY}) { print "$hits\n"; exit 0 }
    if ($hits) { print STDERR "\nINR-only guard: $hits line(s) with a foreign currency, locale, country or UK/UAE tax term.\nFix them, or (rarely) add a commented entry to scripts/inr-only-allowlist.txt. See docs/INR_ONLY.md.\n"; exit 1 }
    print "INR-only guard: clean\n";
  }
'
