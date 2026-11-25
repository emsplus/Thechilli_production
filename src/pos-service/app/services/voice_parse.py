"""Deterministic Hindi / Hinglish / English order parser: text + the compact menu -> the same raw dict the model returns
(voice_order.SCHEMA) plus `clarifications` and `command`. No network, no model. It is the default provider ("local"), the
first stage of the hybrid provider (Gemini is asked only when this parser is not sure), the test double (Fake), and the
server twin of the till's on-device parser (web-business-admin src/lib/voiceParse.ts).

Both parsers read the SAME rules (app/services/voice_lexicon.json, copied byte-identical to the web app by
scripts/sync_voice_fixtures.sh) and are held to the same labelled corpus (tests/fixtures/voice/voice_corpus.json).
The algorithm below mirrors voiceParse.ts function by function (units -> operations -> lines; score_item / match_dish;
pick_variant; note_at; detect_command); change both together.

Principles
- Several dishes that fit about equally ("naan" with Butter and Garlic Naan) are never guessed: a clarification
  (ambiguous_item) the till shows as a one-tap pick. One clear dish is picked even from part of its name ("dosa").
- Options: a size word picks it ("full", "poora", "bada" -> Full; "aadha", "chhota" -> Half); with none said the line gets
  the dish's DEFAULT option, marked "(default)" in the menu text (voice_order.default_variant: the cheapest).
- Only menu refs leave this module; the server still validates them (voice_order.interpret).
- Unknown words end up in `unmatched`, never mapped to the nearest dish.
"""
import json
import pathlib
import re
import unicodedata
from dataclasses import dataclass, field
from fractions import Fraction

LEX = json.loads((pathlib.Path(__file__).with_name("voice_lexicon.json")).read_text(encoding="utf-8"))


# ------------------------------------------------------------------------------------------------ script handling
_CONS = {"क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
         "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
         "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
         "ष": "sh", "स": "s", "ह": "h", "ळ": "l"}
_VOWELS = {"अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o",
           "औ": "au", "ऑ": "o", "ॉ": "o"}
_MATRAS = {"ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ृ": "ri",
           "ॉ": "o", "ॅ": "e"}
_VIRAMA, _NUKTA = "्", "़"


def _translit_word(w: str) -> str:
    out: list[str] = []
    chars = list(w)
    for i, ch in enumerate(chars):
        nxt = chars[i + 1] if i + 1 < len(chars) else ""
        if ch in _CONS:
            out.append(_CONS[ch])
            if nxt not in _MATRAS and nxt != _VIRAMA and nxt != _NUKTA:
                if i + 1 < len(chars):  # inherent 'a' inside a word; a word-final one is silent
                    out.append("a")
        elif ch in _MATRAS:
            out.append(_MATRAS[ch])
        elif ch in _VOWELS:
            out.append(_VOWELS[ch])
        elif ch in "ंँ":
            out.append("n")
        elif ch == "ः":
            out.append("h")
        elif ch in (_VIRAMA, _NUKTA):
            continue
        else:
            out.append(ch)
    return "".join(out)


def _is_deva(ch: str) -> bool:
    return "ऀ" <= ch <= "ॿ"


def to_latin(s: str) -> str:
    """NFKC, any script's digits -> ASCII, Devanagari -> Latin letters, lower case. Gurmukhi/Gujarati digits convert too."""
    s = unicodedata.normalize("NFD", unicodedata.normalize("NFKC", s))
    s = s.replace("़", "")  # nukta: क़ -> क
    s = "".join(str(unicodedata.digit(c)) if unicodedata.category(c) == "Nd" and not c.isascii() else c for c in s)
    s = re.sub(r"[ऀ-ॿ]+", lambda m: _translit_word(m.group(0)), s)
    s = "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))  # accents
    return s.lower()




# ------------------------------------------------------------------------------------------------ lexicon lookups
def _split(xs: list[str]) -> list[tuple[str, ...]]:
    return [tuple(x.lower().split()) for x in xs]


_NUM_WORDS: dict[str, Fraction] = {}
for _k, _ws in LEX["numbers"].items():
    for _w in _ws:
        _NUM_WORDS[_w] = Fraction(_k)
_EN_NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
           "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
           "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
           "eighty": 80, "ninety": 90, "dozen": 12}
_HOMOPHONE = {**{k: v for k, v in LEX["homophone_numbers"].items()}, "won": 1}
_SEPARATORS = set(LEX["separators"]) | {"removed"}  # voice_safety replaced an instruction-like phrase with "[removed]"
_FILLER = set(LEX["fillers"]) | {"more", "another", "same", "again", "phir", "then", "n", "s", "also", "cheers", "mate", "pe", "par", "se", "done"}
_GIVE_DO = _split(LEX["give_do"])
_CORRECTIONS = _split(LEX["corrections"])
_REMOVE_AFTER = _split(LEX["remove_after"])
_REMOVE_BEFORE = {w for w in LEX["remove_before"] if " " not in w}
_REMOVE_LAST = _split(LEX["remove_last"])
_ONE_MORE = _split(LEX["one_more"])
_SAME_AGAIN = _split(LEX["same_again"])
_SYN: dict[str, str] = LEX["synonyms"]
_PHRASE_SYN = sorted(((tuple(k.split()), tuple(v.split())) for k, v in LEX["phrase_synonyms"].items()), key=lambda x: -len(x[0]))
_VARIANT_WORD = {w: canon_ for canon_, ws in LEX["variant_words"].items() for w in ws}
_REGULAR_WORDS = set(LEX["regular_words"])
_SMALL, _LARGE = {"half", "small"}, {"full", "large"}
_SIZE_WORD = set(_VARIANT_WORD) | {"double", "single", "50ml", "25ml", "35ml", "can"}
_REGULAR_WORD = _REGULAR_WORDS | {"half", "chhota", "chota", "chhoti", "small"}
_N = LEX["notes"]
_ING = {w: c for c, ws in _N["ingredients"].items() for w in ws}
_NOTE_MORE, _NOTE_LESS, _NOTE_NONE, _NOTE_NONE_AFTER = (_split(_N[k]) for k in ("more", "less", "none", "none_after"))
_SPICY, _SPICY_MORE, _SPICY_LESS, _MILD = (set(_N[k]) for k in ("spicy_words", "spicy_more", "spicy_less", "mild_words"))
_NOTE_FIXED = sorted(((tuple(k.split()), v) for k, v in _N["fixed"].items()), key=lambda x: -len(x[0]))
_CMD = LEX["commands"]
_CMD_WORDS = sorted(((tuple(w.lower().split()), c) for c, ws in _CMD["words"].items() if c != "_doc" for w in ws), key=lambda x: -len(x[0]))
_CMD_PATTERNS = [(cmd, seq) for cmd, ps in _CMD["patterns"].items() for seq in ps]


def phrase_at(words: list[str], i: int, lst) -> int:
    best = 0
    for p in lst:
        if len(p) > best and tuple(words[i:i + len(p)]) == tuple(p):
            best = len(p)
    return best


def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c)).lower()


def singular(w: str) -> str:
    if len(w) <= 3 or re.search(r"\d", w):
        return w
    if w.endswith("ies"):
        return w[:-3] + "y"
    if re.search(r"(ches|shes|sses|xes)$", w):
        return w[:-2]
    if w.endswith("s") and not w.endswith("ss") and not w.endswith("us"):
        return w[:-1]
    return w


def canon(w: str) -> str:
    s = _strip_accents(w).replace("'", "").replace("’", "")
    if s in _SYN:
        return _SYN[s]
    one = singular(s)
    return _SYN.get(one, one)


def fold_phrases(words: list[str]) -> list[str]:
    out, i = [], 0
    while i < len(words):
        hit = next(((a, b) for a, b in _PHRASE_SYN if tuple(words[i:i + len(a)]) == a), None)
        if hit:
            out.extend(hit[1])
            i += len(hit[0])
        else:
            out.append(words[i])
            i += 1
    return out


def skel(w: str) -> str:
    """Sound skeleton (voiceLexicon.ts skeleton): chai/chaay, paneer/panir, dosa/dosha, lassi/lasi collapse."""
    w = w.replace("ph", "f").replace("ck", "k")
    w = re.sub(r"([bcdgjkpstr])h", r"\1", w).replace("q", "k").replace("z", "j").replace("w", "v").replace("x", "ks")
    w = w.replace("ee", "i").replace("oo", "u").replace("c", "k")
    w = re.sub(r"(.)\1+", r"\1", w).replace("o", "u")
    w = re.sub(r"(.)\1+", r"\1", w)
    return re.sub(r"y$", "i", w)


skeleton = skel


def lev(a: str, b: str) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        for j in range(1, len(b) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1])))
        prev = cur
    return prev[len(b)]


_sim_memo: dict[tuple[str, str], float] = {}


def word_sim(a: str, b: str) -> float:
    """1 = same word, 0.92 = same sound, ~0.68..0.9 = near miss, 0 = different (voiceLexicon.ts rawSim)."""
    if a == b:
        return 1.0
    key = (a, b) if a < b else (b, a)
    v = _sim_memo.get(key)
    if v is not None:
        return v
    if re.search(r"\d", a + b):
        v = 0.0
    else:
        sa, sb = skel(a), skel(b)
        if sa == sb:
            v = 0.92
        elif min(len(sa), len(sb)) < 3:
            v = 0.0
        else:
            r = 1 - lev(sa, sb) / max(len(sa), len(sb))
            r2 = 1 - lev(a, b) / max(len(a), len(b)) if min(len(a), len(b)) >= 4 else 0
            best = max(r, r2)
            v = round(best * 0.9 * 1000) / 1000 if best >= 0.75 else 0.0
    if len(_sim_memo) > 50_000:
        _sim_memo.clear()
    _sim_memo[key] = v
    return v


def normalise(s: str) -> str:
    """Lower-case Latin text, digits ASCII; pauses (, . ; ? ! ।) kept as ' , ' tokens; other punctuation -> spaces."""
    t = to_latin(s)
    t = re.sub(r"(\d)\s*[x×]\s*(?=[a-z])", r"\1 ", t)  # '2x chai'
    t = re.sub(r"(?<=[a-z])\s*[x×]\s*(\d)\b", r" \1", t)  # 'chai x2'
    t = re.sub(r"(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)", " ", t) if not re.search(r"\b[a-z]\d{1,3}\b", t) else t
    t = re.sub(r"[,;!?।]|(?<!\d)\.(?!\d)", " , ", t)
    t = re.sub(r"[^a-z0-9+\s'/,-]", " ", t)
    t = re.sub(r"(?<=[a-z])-(?=[a-z])", " ", t)
    return " ".join(t.replace("'", "").split())



# ------------------------------------------------------------------------------------------------ order details

_TYPE_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b(?:parcel|take\s*away|takeaway|take-away|to\s+go|carry\s*out|pack\s+kar(?:\s+do|\s+dena|o|na)?|pack\s+it|packed|packing|"
                r"le\s+ja(?:ana|na|unga|aunga|ayenge|enge)|le\s+jaa?na)\b"), "takeaway"),
    (re.compile(r"\b(?:home\s+delivery|delivery|deliver|ghar\s+pe|ghar\s+par|ghar\s+bhej)\b"), "delivery"),
    (re.compile(r"\b(?:outside|outdoor|garden|bahar|terrace|lawn)\b"), "outdoor"),
    (re.compile(r"\b(?:dine\s*-?\s*in|eat\s+in|andar|indoor|inside|yahin|yahan\s+khana|yahan\s+khaana|sit\s+down)\b"), "indoor"),
]
_NUMTOK = r"(?:\d{1,3}|" + "|".join(sorted((re.escape(w) for w in _NUM_WORDS if len(w) > 1 and _NUM_WORDS[w].denominator == 1), key=len, reverse=True)) + r")"
_TABLE_RE = re.compile(rf"\b(?:table|tabel|tebal|mez|mej|meza|tbl)\s*(?:number|no\.?|num|nambar|nmbr)?\s*(?:[:#-]\s*)?([a-z]?\s?-?\s?{_NUMTOK})\b")
_TABLE_T_RE = re.compile(r"\b([a-z])\s?-?\s?(\d{1,3})\b(?=\s|$)")  # 'T3', 't 3', 'o2'
_PHONE_RE = re.compile(r"\b(?:phone|mobile|mob|number|nambar|contact|whatsapp)\s*(?:number|no\.?|num)?\s*(?:is|hai|:)?\s*((?:\+?\d[\s-]?){10,14})")
_NAME_RE = re.compile(r"\b(?:customer\s+name|naam|name|nam)\s+(?:is\s+|hai\s+)?([a-z]{2,20})\b")
_NAME_RE2 = re.compile(r"\b([a-z]{2,20})\s+(?:ke\s+naam\s+se|ke\s+liye\s+order)\b")
_BILL_RE = re.compile(rf"(?:\b(?:no|nahi|nahin|nai|sorry|galti|actually)\s*,?\s*)?\bbill\s*(?:number|no\.?|num|nambar)?\s+({_NUMTOK})\b")
_ORD_BILL = {"doosra": 2, "dusra": 2, "doosre": 2, "teesra": 3, "tisra": 3, "second": 2, "third": 3, "pehla": 1, "pehle": 1, "first": 1, "chautha": 4}
_BILL_ORD_RE = re.compile(r"\b(doosra|dusra|doosre|teesra|tisra|second|third|pehla|first|chautha)\s+bill\b")
_NEW_BILL_RE = re.compile(r"\b(?:new|next|naya|nayi|naye|another)\s+bill\b")



# ------------------------------------------------------------------------------------------------ menu
SURE = 0.75
MIN_MATCH = 0.55
TIE = 0.04


@dataclass
class MVariant:
    ref: str
    name: str
    words: list[str]
    size: str | None


@dataclass
class MItem:
    ref: str
    name: str
    words: list[tuple[str, float]]  # (canonical word, weight): name words 1, words in brackets 0.5
    cat_words: list[str] = field(default_factory=list)
    variants: list[MVariant] = field(default_factory=list)
    default: str | None = None  # the option ref a line gets when none is said (marked "(default)"), None = regular

    @property
    def toks(self) -> list[str]:
        return [w for w, _ in self.words]


@dataclass
class Menu:
    items: list[MItem]
    vocab: set[str]
    compounds: dict[str, list[str]]
    menu_words: set[str]
    aliases: dict[str, tuple[MItem, str | None]] = field(default_factory=dict)


def _words_of(s: str) -> list[str]:
    return [w for w in re.split(r"[^\w]+", _strip_accents(to_latin(s)).replace("&", " and ")) if w and w != "_"]


def parse_menu_text(menu: str, aliases: dict | None = None) -> Menu:
    items: list[MItem] = []
    vocab, compounds, menu_words, cat = set(), {}, set(), ""
    for line in menu.splitlines():
        if line.startswith("# "):
            cat = line[2:]
            continue
        m = re.match(r"^(m\d+): (.*?)(?: \[options: (.*)\])?$", line)
        if not m:
            continue
        name = m.group(2)
        main, paren = re.sub(r"\([^)]*\)", " ", name), " ".join(re.findall(r"\(([^)]*)\)", name))
        mw = [w for w in _words_of(main) if w != "and"]
        words = [(canon(w), 1.0) for w in fold_phrases([w for w in mw if not w.isdigit()])]
        words += [(w, 1.0) for w in mw if w.isdigit()]
        words += [(canon(w), 0.5) for w in _words_of(paren) if w != "and" and not w.isdigit() and w not in ("pcs", "pc") and len(w) >= 2]
        it = MItem(m.group(1), name, words, [canon(w) for w in _words_of(cat) if canon(w) not in ("and", "non", "veg", "the", "on")])
        for opt in (m.group(3) or "").split(", "):
            om = re.match(r"^(m\d+v\d+)=(.*?)( \(default\))?$", opt)
            if om:
                vw = [canon(w) for w in _words_of(om.group(2))]
                it.variants.append(MVariant(om.group(1), om.group(2), vw, next((_VARIANT_WORD[w] for w in vw if w in _VARIANT_WORD), None)))
                if om.group(3):
                    it.default = om.group(1)
        for w, _ in it.words:
            vocab.add(w)
            menu_words.add(w)
        for v in it.variants:
            vocab.update(v.words)
            menu_words.update(v.words)
        toks = it.toks
        for i in range(len(toks) - 1):
            compounds[toks[i] + toks[i + 1]] = [toks[i], toks[i + 1]]
        items.append(it)
    menu_ = Menu(items, vocab, compounds, menu_words)
    by_ref = {i.ref: i for i in items}
    for phrase, (ref, vref) in (aliases or {}).items():
        it = by_ref.get(ref)
        if it is None:
            continue
        key = alias_phrase(phrase, menu_) or normalise(phrase)
        menu_.aliases[key] = (it, vref if vref and any(v.ref == vref for v in it.variants) else None)
    return menu_


@dataclass
class Scored:
    it: MItem
    score: float
    item_cov: float
    q_cov: float
    variant: str | None
    count: int
    sizes: list[str]


@dataclass
class DishMatch:
    best: Scored
    ties: list[Scored]
    alternatives: list[MItem]
    conf: float
    margin: float
    words: int = 0


def score_item(words: list[str], it: MItem) -> Scored | None:
    used = [False] * len(words)
    sims = [0.0] * len(words)
    got = total = 0.0
    count = 0
    for w, weight in it.words:
        total += weight
        best, bs = -1, 0.0
        for k, q in enumerate(words):
            if used[k]:
                continue
            s = word_sim(q, w)
            if s > bs:
                bs, best = s, k
        if best >= 0:
            used[best] = True
            sims[best] = bs
            got += weight * bs
            count += 1
    if not got:
        return None
    variant, covered, denom, sizes = None, 0.0, 0, []
    for k, w in enumerate(words):
        if used[k]:
            covered += sims[k]
            denom += 1
            continue
        v = next((x for x in it.variants if any(word_sim(w, vw) >= 0.9 for vw in x.words)), None)
        if v:
            variant = v.ref
            covered += 1
            denom += 1
            continue
        if w in _SIZE_WORD:
            c = _VARIANT_WORD.get(w)
            if c:
                sizes.append(c)
            elif w not in _REGULAR_WORD:
                sizes.append(w)
            continue
        if any(word_sim(w, c) >= 0.9 for c in it.cat_words):
            covered += 1
            denom += 1
            continue
        denom += 1
    item_cov, q_cov = got / total, (covered / denom if denom else 1.0)
    return Scored(it, 0.6 * item_cov + 0.4 * q_cov, item_cov, q_cov, variant, count, sizes)


def match_dish(words: list[str], menu: Menu) -> DishMatch | None:
    if not words:
        return None
    scored = [s for s in (score_item(words, it) for it in menu.items) if s and s.score >= MIN_MATCH and s.q_cov >= 0.5]
    if not scored:
        return None
    scored.sort(key=lambda s: (-s.score, -s.count, len(s.it.name)))
    best = scored[0]
    ties = [s for s in scored[1:] if best.score - s.score < TIE and s.count == best.count]
    runner = scored[1].score if len(scored) > 1 else 0.0
    conf = best.score
    if not ties and best.q_cov >= 0.999 and best.score - runner >= 0.1:
        conf = max(conf, 0.75 + 0.25 * best.item_cov)
    if ties:
        conf = min(conf, 0.6)
    alts = ([s.it for s in scored[1:] if s.score >= max(MIN_MATCH, best.score - 0.15)][:5]
            if ties or conf < SURE or best.score - runner < 0.1 else [])
    return DishMatch(best, ties, alts, conf, best.score - runner, len(words))


def merge_compounds(words: list[str], menu: Menu) -> list[str]:
    out, i = [], 0
    while i < len(words):
        pair = words[i] + words[i + 1] if i + 1 < len(words) else None
        if pair and pair in menu.vocab and words[i] not in menu.vocab:
            out.append(pair)
            i += 2
            continue
        sp = menu.compounds.get(words[i])
        if sp and words[i] not in menu.vocab:
            out.extend(sp)
        else:
            out.append(words[i])
        i += 1
    return out


def split_phrase(words: list[str], menu: Menu, whole: DishMatch | None) -> list[DishMatch] | None:
    best: list = [None, -1.0]

    def go(frm: int, acc: list[DishMatch]) -> None:
        if frm == len(words):
            if len(acc) >= 2:
                mn = min(p.best.score for p in acc)
                if best[0] is None or mn > best[1]:
                    best[0], best[1] = list(acc), mn
            return
        if len(acc) >= 3:
            return
        for to in range(frm + 1, min(len(words), frm + 4) + 1):  # a dish name is at most four words here
            if to - frm == len(words):
                continue
            m = match_dish(words[frm:to], menu)
            if not m or m.ties or m.best.q_cov < 0.999 or m.best.score < 0.7 or m.margin < 0.15:
                continue
            go(to, acc + [m])

    go(0, [])
    if best[0] is None or (whole and not whole.ties and best[1] <= whole.best.score):
        return None
    return best[0]


def pick_variant(it: MItem, matched: str | None, sizes: list[str]) -> tuple[str | None, bool, list[str]]:
    """-> (option ref or None for regular, defaulted, unknown size words). Same rules as voiceParse.ts pickVariant."""
    if matched:
        return matched, False, []
    unknown: list[str] = []
    chosen: list = []
    for s in sizes:
        exact = next((v for v in it.variants if v.size == s), None)
        if exact:
            chosen = [exact.ref]
            continue
        if not it.variants:
            if s not in _REGULAR_WORD or s == "half":
                unknown.append(s)
            continue
        if s in _SMALL or s in _REGULAR_WORDS:
            chosen = [it.default]
            continue
        if s in _LARGE:
            big = next((v for v in it.variants if v.size in _LARGE), None) or next((v for v in reversed(it.variants) if v.ref != it.default), None)
            if big:
                chosen = [big.ref]
                continue
        unknown.append(s)
    if chosen:
        return chosen[0], False, unknown
    return it.default, it.default is not None, unknown


# ------------------------------------------------------------------------------------------------ learnt phrases
_ALIAS_NEAR, _ALIAS_GAP = 0.7, 0.05


def _near_alias(words: list[str], menu: Menu):
    best, second = None, 0.0
    joined = "".join(words)
    for key, a in menu.aliases.items():
        kw = key.split(" ")
        score = word_sim(joined, "".join(kw))
        if len(kw) == len(words):
            per = [word_sim(words[i], w) for i, w in enumerate(kw)]
            if all(x > 0 for x in per):
                score = max(score, sum(per) / len(per))
        if best and score <= best[1]:
            second = max(second, score)
            continue
        if best:
            second = max(second, best[1])
        best = (a, score)
    return best[0] if best and best[1] >= _ALIAS_NEAR and best[1] - second >= _ALIAS_GAP else None


def find_alias(words: list[str], menu: Menu):
    """-> (item, option ref, unknown sizes, sizes, fuzzy) or None (voiceParse.ts findAlias)."""
    if not menu.aliases or not words:
        return None
    exact = menu.aliases.get(" ".join(words))
    if exact:
        return exact[0], exact[1], [], [], False
    plain = [w for w in words if w not in _SIZE_WORD]
    fuzzy = False
    a = menu.aliases.get(" ".join(plain)) if plain and len(plain) < len(words) else None
    if not a and plain:
        a = _near_alias(plain, menu)
        fuzzy = bool(a)
    if not a:
        return None
    it, vref = a
    unknown, sizes = [], []
    for w in words:
        if w not in _SIZE_WORD:
            continue
        v = next((x for x in it.variants if any(word_sim(w, vw) >= 0.9 for vw in x.words)), None)
        if v:
            vref = v.ref
        elif w in _VARIANT_WORD and it.variants:
            sizes.append(_VARIANT_WORD[w])
        elif w in _REGULAR_WORD:
            vref = None
        else:
            unknown.append(w)
    return it, vref, unknown, sizes, fuzzy


_TABLE_WORD = r"(?:table|tabel|tebal|mez|mej|meza|tbl)\s*(?:number|no\.?|num|nambar|nmbr)?\s*(?:[:#-]\s*)?"
_AREA_WORD = {"outdoor": "outdoor", "outside": "outdoor", "garden": "outdoor", "bahar": "outdoor", "terrace": "outdoor", "lawn": "outdoor",
              "indoor": "indoor", "inside": "indoor", "andar": "indoor"}


def _tkey(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _known_table(t: str, protected: set[str], tables: list[tuple[str, str]] | None, info: dict) -> str:
    """A letter-prefixed label this restaurant really has, said with or without the word table: 'table AC3', 'AC 2', 'ac-2',
    'G1'. Only an exact label of this restaurant (never a word of a dish name). Sets info["table"] to the label as stored."""
    prefixes: dict[str, dict[str, str]] = {}
    for label, _area in tables or ():
        m = re.fullmatch(r"([a-z]+)0*(\d{1,3})", _tkey(label))
        if m:
            prefixes.setdefault(m.group(1), {})[str(int(m.group(2)))] = label
    if not prefixes:
        return t
    pre = "|".join(sorted(map(re.escape, prefixes), key=len, reverse=True))
    rx = re.compile(rf"\b(?:{_TABLE_WORD})?({pre})\s?-?\s?(\d{{1,3}})\b")
    for m in rx.finditer(t):
        label = prefixes[m.group(1)].get(str(int(m.group(2))))
        if label is None:
            continue
        said_table = re.match(_TABLE_WORD, m.group(0)) is not None
        if not said_table and any(m.group(0) in n for n in protected):
            continue
        info["table"] = label
        return t[:m.start()] + " , " + t[m.end():]
    return t


def _area_table(t: str, tables: list[tuple[str, str]] | None, info: dict) -> str:
    """'garden 1 ek chicken 65' -> G1: an area word then a bare number names that area's table only when it is the one table
    of that area with that number AND a quantity or a pause follows ('outdoor 2 samosa' stays two samosas, as voiceParse.ts)."""
    if "table" in info or not tables:
        return t
    for m in re.finditer(rf"\b({'|'.join(_AREA_WORD)})\s+(\d{{1,3}}|{_NUMTOK})\b(?=\s*,|\s*$|\s+{_NUMTOK}\b)", t):
        v = m.group(2)
        n = int(v) if v.isdigit() else int(_NUM_WORDS[v]) if v in _NUM_WORDS and _NUM_WORDS[v].denominator == 1 else None
        fit = [lb for lb, area in tables if area == _AREA_WORD[m.group(1)] and re.fullmatch(rf"[a-z]*0*{n}", _tkey(lb))] if n else []
        if len(fit) == 1:
            info["table"] = fit[0]
            return t[:m.start(2)] + " , " + t[m.end(2):]
    return t


def _extract(t: str, protected_names: set[str], tables: list[tuple[str, str]] | None = None) -> tuple[str, dict]:
    """Pull table / phone / customer / bill / order type out of the normalised text; returns the rest."""
    info: dict = {}
    m = _PHONE_RE.search(t)
    if m:
        info["phone"] = re.sub(r"[\s-]", "", m.group(1))
        t = t[:m.start()] + " , " + t[m.end():]
    m = _BILL_ORD_RE.search(t)
    if m:
        info["bill_no"] = _ORD_BILL[m.group(1)]
        t = t[:m.start()] + " , " + t[m.end():]
    m = _NEW_BILL_RE.search(t)
    if m:
        info["new_bill"] = True
        t = t[:m.start()] + " , " + t[m.end():]
    # every "bill number N" is taken out (the LAST one said wins: "bill 2 ... sorry bill 3"), with a correction word just
    # before it ("no bill number 2"), which is about the bill and never about the dish said before it (as voiceParse.ts)
    while (m := _BILL_RE.search(t)):
        v = m.group(1)
        info["bill_no"] = int(v) if v.isdigit() else int(_NUM_WORDS[v])
        t = t[:m.start()] + " , " + t[m.end():]
    t = _known_table(t, protected_names, tables, info)
    m = None if "table" in info else _TABLE_RE.search(t)
    if m:
        lab = m.group(1).replace(" ", "").replace("-", "")
        mm = re.fullmatch(r"([a-z]?)(.+)", lab)
        pre, num = mm.group(1), mm.group(2)
        if num not in _NUM_WORDS and not num.isdigit() and pre:  # 'tfive' style glued: keep letter out
            num, pre = (pre + num), ""
        if num.isdigit():
            info["table"] = (pre + num).upper() if pre else num
        elif num in _NUM_WORDS and _NUM_WORDS[num].denominator == 1:
            info["table"] = (pre.upper() + str(int(_NUM_WORDS[num])))
        t = t[:m.start()] + " , " + t[m.end():]
    elif "table" not in info:
        m = re.search(r"\b(?:table|mez)\b", t)
        mt = _TABLE_T_RE.search(t)
        if mt and mt.group(1) in "tom" and not any(mt.group(0) in n for n in protected_names):
            info["table"] = (mt.group(1) + mt.group(2)).upper()
            t = t[:mt.start()] + " , " + t[mt.end():]
        elif m:
            t = t[:m.start()] + " , " + t[m.end():]
    t = _area_table(t, tables, info)
    m = _NAME_RE.search(t) or _NAME_RE2.search(t)
    if m and m.group(1) not in _NUM_WORDS and m.group(1) not in _FILLER:
        info["name"] = m.group(1).title()
        t = t[:m.start()] + " , " + t[m.end():]
    for rx, kind in _TYPE_PATTERNS:
        m = rx.search(t)
        if m:
            info.setdefault("order_type", kind)
            t = t[:m.start()] + " , " + t[m.end():]
    return " ".join(t.split()), info



def _protect(t: str, menu: Menu) -> set[str]:
    return {" ".join(normalise(i.name).split()) for i in menu.items}


# ------------------------------------------------------------------------------------------------ units
@dataclass
class Tok:
    w: str
    i: int


@dataclass
class Unit:
    k: str  # w n sep x corr rmAfter rmBefore rmLast more same each note
    t: Tok | None = None
    v: Fraction | None = None
    toks: list[Tok] = field(default_factory=list)
    homophone: bool = False
    text: str = ""


def _number_at(ws: list[str], i: int) -> tuple[Fraction, int, bool] | None:
    if i >= len(ws) or ws[i] == ",":
        return None
    w = ws[i]
    if re.fullmatch(r"\d{1,3}", w):
        return (Fraction(int(w)), 1, False) if int(w) > 0 else None
    en = _EN_NUM.get(w)
    if en is not None:
        nx = ws[i + 1] if i + 1 < len(ws) else None
        if en >= 20 and en % 10 == 0 and nx in _EN_NUM and _EN_NUM[nx] < 10:
            return Fraction(en + _EN_NUM[nx]), 2, False
        return Fraction(en), 1, False
    hi = _NUM_WORDS.get(w)
    if hi is not None and hi != Fraction(1, 2):  # a half ("aadha", "half") is a size, not a count
        return hi, 1, False
    ho = _HOMOPHONE.get(w)
    if ho is not None:
        return Fraction(ho), 1, True
    return None


def note_at(ws: list[str], i: int, menu: Menu) -> tuple[str, int] | None:
    for p, v in _NOTE_FIXED:
        if tuple(ws[i:i + len(p)]) == p:
            return v, len(p)
    if i >= len(ws):
        return None
    w = ws[i]
    nx = ws[i + 1] if i + 1 < len(ws) else None
    if w in _SPICY_MORE and nx in _SPICY:
        return "extra spicy", 2
    if w in _SPICY_LESS and nx in _SPICY:
        return "less spicy", 2
    if w in _MILD and w not in menu.menu_words:
        return "less spicy", 1
    for lst, word in ((_NOTE_MORE, "extra"), (_NOTE_LESS, "less"), (_NOTE_NONE, "no")):
        n = phrase_at(ws, i, lst)
        if not n:
            continue
        ing = ws[i + n] if i + n < len(ws) else None
        if ing is None or ing == ",":
            return None
        if ing in _ING:
            return f"{word} {_ING[ing]}", n + 1
        if ing in _SPICY:
            return ("not spicy" if word == "no" else f"{word} spicy"), n + 1
        if (word != "no" or w != "no") and ing not in _NUM_WORDS and ing not in _EN_NUM and not ing.isdigit() \
                and ing not in _SEPARATORS and ing not in _FILLER:
            return f"{word} {ing}", n + 1
        return None
    if w in _ING and nx is not None:
        n = phrase_at(ws, i + 1, _NOTE_NONE_AFTER)
        if n:
            return f"no {_ING[w]}", n + 1
        l = phrase_at(ws, i + 1, _NOTE_LESS)
        if l and (i + 1 + l >= len(ws) or ws[i + 1 + l] == ","):
            return f"less {_ING[w]}", l + 1
    if w in _SPICY and w not in menu.menu_words:
        return "spicy", 1
    return None


def _and_pair(ws: list[str], i: int, menu: Menu) -> bool:
    if i == 0 or i + 1 >= len(ws):
        return False
    a, b = canon(ws[i - 1]), canon(ws[i + 1])
    return any(re.search(r"(&|\band\b)", it.name, re.I) and a in it.toks and b in it.toks for it in menu.items)


def build_units(ws: list[str], menu: Menu) -> list[Unit]:
    """Words left after the table / phone / name / bill / type words -> units (voiceParse.ts buildUnits)."""
    units: list[Unit] = []

    def sep() -> None:
        if units and units[-1].k != "sep":
            units.append(Unit("sep"))

    i = 0
    while i < len(ws):
        w = ws[i]
        if w == ",":
            sep()
            i += 1
            continue
        run = []
        for j in range(i, min(len(ws), i + 6)):
            if ws[j] == ",":
                break
            run.append(ws[j])
        k = phrase_at(run, 0, _REMOVE_LAST)
        if k:
            units.append(Unit("rmLast")); i += k; continue
        k = phrase_at(run, 0, _SAME_AGAIN)
        if k:
            units.append(Unit("same")); i += k; continue
        k = phrase_at(run, 0, _REMOVE_AFTER)
        if k:
            units.append(Unit("rmAfter")); i += k; continue
        k = phrase_at(run, 0, _GIVE_DO)
        if k:
            i += k
            continue
        k = phrase_at(run, 0, _ONE_MORE)
        if k:
            units.append(Unit("more", toks=[Tok(x, i + n) for n, x in enumerate(run[:k])])); i += k; continue
        note = note_at(run, 0, menu)
        if note:
            units.append(Unit("note", text=note[0])); i += note[1]; continue
        if w in _REMOVE_BEFORE and w not in menu.menu_words:
            units.append(Unit("rmBefore")); i += 1; continue
        if w in ("x", "times") and units and units[-1].k == "w" and _number_at(ws, i + 1):
            units.append(Unit("x")); i += 1; continue
        num = _number_at(ws, i)
        prev = units[-1] if units else None
        if num and w.isdigit() and prev is not None and prev.k == "w" and any(
                w in it.toks and canon(prev.t.w) in it.toks for it in menu.items):
            units.append(Unit("w", t=Tok(w, i))); i += 1; continue  # "chicken 65": the number is part of the name
        if num:
            v, ln, homo = num
            nx = ws[i + ln] if i + ln < len(ws) else None
            if nx in ("dozen", "darjan") and v < 12:
                v *= 12
                ln += 1
            again = _number_at(ws, i + ln)
            if again and again[0] == v and not homo and not w[0].isdigit() and v < 12:
                units.append(Unit("each", v=v)); i += ln + again[1]; continue
            units.append(Unit("n", v=v, toks=[Tok(x, i + n) for n, x in enumerate(ws[i:i + ln])], homophone=homo))
            i += ln
            continue
        k = phrase_at(run, 0, _CORRECTIONS)
        if k:
            units.append(Unit("corr")); i += k; continue
        if w in _SEPARATORS and not _and_pair(ws, i, menu):
            sep(); i += 1; continue
        if w in _FILLER and canon(w) not in menu.menu_words:
            i += 1
            continue
        units.append(Unit("w", t=Tok(w, i)))
        i += 1
    return units


@dataclass
class Seg:
    toks: list[Tok]
    qty_toks: list[Tok]
    qty: Fraction | None
    mods: list[str]
    homophone: bool


_BREAKS = {"sep", "corr", "rmAfter", "rmBefore", "rmLast", "more", "same"}


def run_units(units: list[Unit]) -> list[tuple]:
    """Units -> operations (voiceParse.ts runUnits): ('add', seg) ('fix', seg) ('setqty', q) ('inc', n) ('same',)
    ('note', text) ('remove', toks) ('removeLast',)."""
    ops: list[tuple] = []
    postfix = [False] * len(units)
    a = 0
    while a < len(units):
        b = a
        while b < len(units) and units[b].k not in _BREAKS:
            b += 1
        body = [u for u in units[a:b] if u.k != "note"]
        pf = len(body) > 1 and body[0].k == "w" and body[-1].k == "n"
        for i in range(a, b):
            postfix[i] = pf
        a = b + 1

    def word_ahead(i: int, skip_num: bool = False) -> bool:
        for j in range(i + 1, len(units)):
            k = units[j].k
            if k == "w":
                return True
            if k == "note" or (skip_num and k == "n"):
                continue
            return False
        return False

    st = {"cur": None, "pq": None, "ptok": [], "phomo": False, "pmods": [], "mode": None, "corr": None, "each": None}

    def flush() -> None:
        if st["cur"] is not None and st["cur"].toks:
            ops.append(("add", st["cur"]))
        st["cur"] = None

    def end_corr() -> None:
        c, mode = st["corr"], st["mode"]
        if c is not None and c.toks:
            ops.append(("remove", c.toks) if mode == "rm" else ("fix", c))
        elif c is not None and c.qty is not None and mode == "corr":
            ops.append(("setqty", c.qty))
        st["corr"], st["mode"] = None, None

    def fresh() -> Seg:
        s = Seg([], st["ptok"], st["pq"] if st["pq"] is not None else st["each"], st["pmods"], st["phomo"])
        st["pq"], st["ptok"], st["pmods"], st["phomo"] = None, [], [], False
        return s

    for i, u in enumerate(units):
        k = u.k
        cur = st["cur"]
        if k == "w":
            if st["mode"]:
                if st["corr"] is None:
                    st["corr"] = fresh()
                st["corr"].toks.append(u.t)
            else:
                if cur is None:
                    st["cur"] = cur = fresh()
                cur.toks.append(u.t)
        elif k == "x":
            continue
        elif k == "n":
            prev_x = i > 0 and units[i - 1].k == "x"
            if st["mode"] == "rm" and st["corr"] is not None and st["corr"].toks:
                end_corr()
            if st["mode"] == "corr":
                if st["corr"] is not None and st["corr"].toks:
                    end_corr()
                if word_ahead(i):
                    st["corr"], st["mode"] = Seg([], u.toks, u.v, [], False), "corr"
                else:
                    flush()
                    ops.append(("setqty", u.v))
                    st["mode"], st["corr"] = None, None
                continue
            if u.homophone and ((cur is not None and cur.toks) or st["pq"] is not None or not word_ahead(i)):
                continue
            if cur is not None and cur.toks:
                if cur.qty is None or prev_x or cur.qty == st["each"]:
                    if prev_x or postfix[i] or not word_ahead(i):
                        cur.qty = u.v
                        cur.qty_toks = cur.qty_toks + u.toks
                        flush()
                        continue
                flush()
            if st["pq"] is not None and st["pq"] != u.v and not st["phomo"]:
                ops.append(("clar", "unclear_quantity", f"{_fmt(st['pq'])} {_fmt(u.v)}"))  # "do teen samosa": the later number is used, staff check
            st["pq"], st["ptok"], st["phomo"] = u.v, u.toks, u.homophone
            st["each"] = None
        elif k == "each":
            flush()
            st["each"] = u.v
        elif k == "sep":
            if st["mode"] and st["corr"] is not None and (st["corr"].toks or st["corr"].qty is not None):
                end_corr()
            flush()
        elif k == "corr":
            if st["mode"]:
                end_corr()
            flush()
            st["mode"], st["corr"] = "corr", None
        elif k == "rmBefore":
            if st["mode"]:
                end_corr()
            if cur is not None and cur.toks and not word_ahead(i):
                ops.append(("remove", cur.toks))
                st["cur"] = None
                continue
            flush()
            if word_ahead(i):
                st["mode"], st["corr"] = "rm", None
            else:
                ops.append(("removeLast",))
        elif k == "rmAfter":
            if cur is not None and cur.toks:
                ops.append(("remove", cur.toks))
                st["cur"] = None
                continue
            if st["mode"] and st["corr"] is not None and st["corr"].toks:
                st["mode"] = "rm"
                end_corr()
                continue
            if st["mode"]:
                end_corr()
            ops.append(("removeLast",))
        elif k == "rmLast":
            if st["mode"]:
                end_corr()
            flush()
            ops.append(("removeLast",))
        elif k == "more":
            if st["mode"]:
                end_corr()
            if cur is not None and cur.toks and cur.qty is None:
                cur.qty = Fraction(1)
                flush()
                continue
            flush()
            if word_ahead(i):
                st["pq"], st["ptok"] = Fraction(1), u.toks
            else:
                ops.append(("inc", 1))
        elif k == "same":
            if st["mode"]:
                end_corr()
            flush()
            ops.append(("same",))
        elif k == "note":
            c = st["corr"] if st["mode"] else cur
            if c is not None and c.toks:
                c.mods.append(u.text)
            elif word_ahead(i, True):
                st["pmods"].append(u.text)
            else:
                ops.append(("note", u.text))
    if st["mode"]:
        end_corr()
    flush()
    if st["pq"] is not None and not st["phomo"]:
        ops.append(("clar", "quantity_without_dish", _fmt(st["pq"])))
    return ops


# ------------------------------------------------------------------------------------------------ lines
def dish_words(toks: list[Tok], menu: Menu) -> list[str]:
    raw = [t.w for t in toks if not (t.w in _FILLER and canon(t.w) not in menu.menu_words)]
    out: list[str] = []
    for w in fold_phrases(raw):
        c = canon(w)
        out.extend(c.split(" "))
    return out


def alias_phrase(text: str, menu: Menu) -> str:
    """The key a heard phrase is learnt under (voiceParse.ts aliasPhrase): quantities, fillers and notes dropped."""
    ws = [w for w in normalise(text).split()]
    return " ".join(dish_words([u.t for u in build_units(ws, menu) if u.k == "w"], menu))


@dataclass
class Line:
    item: MItem
    variant: str | None
    qty: Fraction
    note: str | None
    heard: str
    conf: float
    ask: list[MItem] = field(default_factory=list)
    explicit: bool = False
    defaulted: bool = False
    issues: list[str] = field(default_factory=list)


_LEADING_JOINERS = {"aur", "and", "bhi", "plus", "also", "phir", "then", "or"}


def make_lines(s: Seg, menu: Menu, ws: list[str]) -> tuple[list[Line], str | None]:
    """A segment -> its lines, or ([], unmatched text)."""
    allt = sorted(s.toks + s.qty_toks, key=lambda t: t.i)
    heard = " ".join(ws[allt[0].i:allt[-1].i + 1]).replace(" ,", ",") if allt else ""
    words = dish_words(s.toks, menu)
    note = ", ".join(dict.fromkeys(s.mods)) or None
    qty = s.qty if s.qty is not None else Fraction(1)
    if not words:
        return [], None
    merged = merge_compounds(words, menu)
    near = find_alias(words, menu)
    m = match_dish(merged, menu)
    learnt = near if near and (not near[4] or not (m and m.conf >= SURE and not m.ties)) else None
    parts = None
    if not learnt and len(merged) >= 2 and (not m or m.ties or m.best.q_cov < 0.999):
        parts = split_phrase(merged, menu, m)
    if not learnt and not m:
        ws_ = [w for w in heard.split() if w != ","]
        while ws_ and ws_[0] in _LEADING_JOINERS:  # "aur ek pizza" -> "ek pizza": the joiner is not part of the phrase
            ws_.pop(0)
        return [], " ".join(ws_)
    issues = []
    if s.homophone and s.qty is not None:
        issues.append("check the quantity")
    explicit = s.qty is not None
    if learnt:
        it, vref, unknown, sizes, _ = learnt
        v, d = (vref, False) if vref else pick_variant(it, None, sizes)[:2]
        return [Line(it, v, qty, note, heard, 1.0, explicit=explicit, defaulted=d, issues=issues)], None
    if parts:
        out = []
        for k, p in enumerate(parts):
            v, d, _ = pick_variant(p.best.it, p.best.variant, p.best.sizes)
            # a dish found from ONE word inside a longer phrase ("lime soda sweet") is a guess: not sure
            conf = min(p.conf, 0.7) if len(p.best.it.words) > 1 and p.words == 1 else p.conf
            out.append(Line(p.best.it, v, qty if k == 0 else Fraction(1), note, heard, round(conf, 2), explicit=explicit, defaulted=d, issues=list(issues)))
        return out, None
    best = m.best
    conf = round(m.conf, 2)
    if m.ties and any(c.variant or c.sizes for c in [best, *m.ties]):
        # an option word with a dish word that fits several dishes ("full tandoori"): only one of them has that option
        fit = [c for c in [best, *m.ties] if c.it.variants and (c.variant or not pick_variant(c.it, None, c.sizes)[2])]
        if len(fit) == 1:
            best, conf = fit[0], max(conf, SURE)
            v, d, _ = pick_variant(best.it, best.variant, best.sizes)
            return [Line(best.it, v, qty, note, heard, conf, explicit=explicit, defaulted=d, issues=issues)], None
    if m.ties:
        return [Line(best.it, None, qty, note, heard, conf, ask=[best.it] + [t.it for t in m.ties] + [a for a in m.alternatives if a not in [t.it for t in m.ties]],
                     explicit=explicit)], None
    if qty.denominator != 1:
        half = next((v for v in best.it.variants if v.size == "half"), None)
        full = next((v for v in best.it.variants if v.size == "full"), None)
        if half and full:  # "dedh plate" = one Full + one Half; "dhai" = two Full + one Half
            out = []
            if int(qty) >= 1:
                out.append(Line(best.it, full.ref, Fraction(int(qty)), note, heard, conf, explicit=True, issues=list(issues)))
            out.append(Line(best.it, half.ref, Fraction(1), note, heard, conf, explicit=True, issues=list(issues)))
            return out, None
        v, d, _ = pick_variant(best.it, best.variant, best.sizes)
        return [Line(best.it, v, qty, note, heard, min(conf, 0.5), explicit=True, defaulted=d, issues=issues)], None  # -> clarification
    v, d, unknown = pick_variant(best.it, best.variant, best.sizes)
    if "half" in unknown:  # half a dish that has no Half option: asked, never guessed
        return [Line(best.it, v, Fraction(1, 2), note, heard, min(conf, 0.5), explicit=True, issues=issues)], None
    if d and best.q_cov < 0.999:  # an unknown word next to a dish with options may have been the option ("poori plate")
        conf = min(conf, 0.7)
    return [Line(best.it, v, qty, note, heard, conf, explicit=explicit, defaulted=d, issues=issues)], None


# ------------------------------------------------------------------------------------------------ till commands
def detect_command(text: str, menu_words: set[str] | None = None) -> tuple[str | None, str]:
    """(command, text before it): 'place' | 'kot' | 'clear' said at the END (clear: alone). voiceCommands.ts detectCommand."""
    raw = re.findall(r"[\w][\w.'’-]*", text, re.UNICODE)
    ws = [re.sub(r"[.-]$", "", _strip_accents(to_latin(w)).replace("'", "").replace("’", "")) for w in raw]
    if not ws:
        return None, text
    toks: list[tuple[str, int, int]] = []  # canon, first word, word count
    i = 0
    while i < len(ws):
        hit = next(((p, c) for p, c in _CMD_WORDS if tuple(ws[i:i + len(p)]) == p), None)
        if hit:
            toks.append(("_" if hit[1] == "to" else hit[1], i, len(hit[0])))
            i += len(hit[0])
        else:
            toks.append(("?", i, 1))
            i += 1

    def ending_at(end: int, wanted=None):
        best = None
        for cmd, seq in _CMD_PATTERNS:
            if cmd == "new_bill" or (wanted and cmd not in wanted):
                continue
            j, k = end, len(seq) - 1
            while k >= 0 and j >= 0:
                if toks[j][0] == "_":
                    j -= 1
                    continue
                if toks[j][0] != seq[k]:
                    break
                k -= 1
                j -= 1
            if k < 0 and (best is None or len(seq) > best[2]):
                best = (cmd, j + 1, len(seq))
        return best

    end = len(toks) - 1
    while end >= 0 and toks[end][0] == "_":
        end -= 1
    if end < 0:
        return None, text
    last = ending_at(end)
    if not last:
        return None, text
    cmd, frm, _ = last
    if cmd == "clear":
        if any(t[0] != "_" for t in toks[:frm]):
            return None, text
        return "clear", ""
    k = frm - 1
    while k >= 0 and toks[k][0] in ("_", "link"):
        k -= 1
    if k >= 0:
        before = ending_at(k, ("place", "kot"))
        if before:
            frm = before[1]
            if before[0] == "kot":
                cmd = "kot"
    span = ws[toks[frm][1]:]
    if menu_words is not None and all(w in menu_words or w in ("to", "the", "me", "mein", "ko", "in", "please") for w in span):
        return None, text
    rest_end = frm
    while rest_end > 0 and toks[rest_end - 1][0] in ("link", "_"):
        rest_end -= 1
    if rest_end == 0:
        return cmd, ""
    last_word = toks[rest_end - 1][1] + toks[rest_end - 1][2] - 1
    # cut the original text after that word
    pos, n = 0, -1
    for mm in re.finditer(r"[\w][\w.'’-]*", text, re.UNICODE):
        n += 1
        if n == last_word:
            pos = mm.end()
            break
    return cmd, text[:pos].rstrip(" ,.;:!?")


# ------------------------------------------------------------------------------------------------ utterance
@dataclass
class Parsed:
    lines: list[dict] = field(default_factory=list)
    unmatched: list[str] = field(default_factory=list)
    clarifications: list[dict] = field(default_factory=list)
    info: dict = field(default_factory=dict)
    command: str | None = None


def parse(menu_text: str, text: str, aliases: dict[str, tuple[str, str | None]] | None = None,
          tables: list[tuple[str, str]] | None = None) -> Parsed:
    menu = parse_menu_text(menu_text, aliases)
    command, rest = detect_command(text, menu.menu_words)
    t, info = _extract(normalise(rest), _protect(rest, menu), tables)
    ws = t.split()
    # "sixty five" -> "65" after a dish word when the menu has that number ("chicken sixty five")
    for i in range(1, len(ws) - 1):
        a, b = _EN_NUM.get(ws[i]), _EN_NUM.get(ws[i + 1])
        if a and b and a >= 20 and a % 10 == 0 and b < 10 and str(a + b) in menu.vocab and canon(ws[i - 1]) in menu.menu_words:
            ws[i:i + 2] = [str(a + b), ","] if False else [str(a + b)]
            break
    res = Parsed(info=info, command=command)
    lines: list[Line] = []

    def find(toks: list[Tok]) -> int:
        words = dish_words(toks, menu)
        if not words:
            return -1
        m = match_dish(merge_compounds(words, menu), menu)
        al = find_alias(words, menu)
        refs = {x.ref for x in ([al[0]] if al else []) + ([m.best.it] + [t.it for t in m.ties] if m else [])}
        for k in range(len(lines) - 1, -1, -1):
            if lines[k].item.ref in refs:
                return k
        return -1

    def add(seg: Seg) -> list[Line]:
        ls, un = make_lines(seg, menu, ws)
        if not ls and un:
            res.unmatched.append(un)
        return ls

    for op in run_units(build_units(ws, menu)):
        last = lines[-1] if lines else None
        kind = op[0]
        if kind == "add":
            seg = op[1]
            words = dish_words(seg.toks, menu)
            if last and words and all(w in _VARIANT_WORD for w in words) and last.item.variants:
                last.variant, last.defaulted, _ = pick_variant(last.item, None, [_VARIANT_WORD[w] for w in words])
                continue
            lines.extend(add(seg))
        elif kind == "setqty":
            if last:
                last.qty, last.explicit = op[1], True
            else:
                res.clarifications.append({"heard_text": _fmt(op[1]), "reason": "quantity_without_dish", "item_refs": [], "quantity": None})
        elif kind == "inc":
            if last:
                last.qty += op[1]
        elif kind == "same":
            if last:
                last.qty *= 2
        elif kind == "note":
            if last:
                last.note = ", ".join(x for x in (last.note, op[1]) if x)
            else:
                res.unmatched.append(op[1])
        elif kind == "removeLast":
            if lines:
                lines.pop()
        elif kind == "remove":
            k = find(op[1])
            if k >= 0:
                lines.pop(k)
            else:  # nothing to remove: reported, not silently dropped
                res.unmatched.append(" ".join(t.w for t in op[1]))
        elif kind == "clar":
            res.clarifications.append({"heard_text": op[2], "reason": op[1], "item_refs": [], "quantity": None})
        elif kind == "fix":
            seg = op[1]
            words = dish_words(seg.toks, menu)
            if last and words and all(w in _VARIANT_WORD for w in words):
                last.variant, last.defaulted, _ = pick_variant(last.item, None, [_VARIANT_WORD[w] for w in words])
                if seg.qty is not None:
                    last.qty = seg.qty
                continue
            k = find(seg.toks)
            if k >= 0:
                if seg.qty is not None:
                    lines[k].qty, lines[k].explicit = seg.qty, True
                continue
            if seg.qty is None and last and last.explicit:
                seg = Seg(seg.toks, seg.qty_toks, last.qty, seg.mods, seg.homophone)
            if last and last.note:
                seg.mods = [last.note] + seg.mods
            ls = add(seg)
            if ls:
                if last:
                    lines.pop()
                lines.extend(ls)

    for ln in lines:
        q = max(1, min(99, int(ln.qty))) if ln.qty.denominator == 1 else None
        if ln.ask:
            seen, refs = set(), []
            for x in ln.ask:
                if x.ref not in seen:
                    seen.add(x.ref)
                    refs.append(x.ref)
            res.clarifications.append({"heard_text": ln.heard, "reason": "ambiguous_item", "item_refs": refs[:6], "quantity": q, "note": ln.note})
            continue
        if q is None:
            res.clarifications.append({"heard_text": ln.heard, "reason": "fractional_quantity", "item_refs": [ln.item.ref], "quantity": None, "note": ln.note})
            continue
        res.lines.append({"item_ref": ln.item.ref, "variant_ref": ln.variant, "quantity": q, "note": ln.note,
                          "heard_text": ln.heard, "confidence": ln.conf, "defaulted": ln.defaulted})
    return res


def _fmt(q: Fraction) -> str:
    return str(int(q)) if q.denominator == 1 else f"{q.numerator}/{q.denominator}"


def to_raw(p: Parsed, transcript: str | None) -> dict:
    info = p.info
    return {"transcript": transcript, "lines": p.lines, "unmatched": p.unmatched, "clarifications": p.clarifications,
            "customer_name": info.get("name"), "customer_phone": info.get("phone"),
            "order_type": info.get("order_type"), "table_label": info.get("table"),
            "bill_no": info.get("bill_no"), "new_bill": info.get("new_bill"), "command": p.command}


def parse_to_raw(menu_text: str, text: str, aliases: dict | None = None, tables: list[tuple[str, str]] | None = None) -> dict:
    """tables = [(label, area)] of the restaurant: lets 'table AC3', 'AC 2' and 'garden 1' be heard (without it only T / O / M
    labels and bare numbers are)."""
    return to_raw(parse(menu_text, text, aliases, tables), text)


def is_confident(raw: dict) -> bool:
    """The local result needs no model: every phrase matched one dish surely, nothing to clarify or unmatched."""
    return not raw.get("unmatched") and not raw.get("clarifications") and all(
        (ln.get("confidence") or 0) >= SURE for ln in raw.get("lines") or [])
