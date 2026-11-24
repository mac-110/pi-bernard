#!/usr/bin/env python3
"""Compares what Bernard's gateway rejected with what it accepted, across local Pi sessions.

The gateway's rules are not published. This script runs the rules of the OWASP Core Rule Set (CRS) that
inspect request content against every Bernard request Pi stored, and lists the rules and patterns that match
rejected requests, with the number of accepted requests they also match. A pattern found only in rejected
requests is a candidate; a pattern the gateway accepted elsewhere is not the cause.

Treat the results as hints. ModSecurity is only approximated: common transformations are imitated, chained
conditions and anomaly scores are ignored, and regexes Python cannot compile are skipped. Each request is
represented by the messages Pi stored since the previous reply; the system prompt, tool declarations, and the
history a new Bernard thread synchronizes are not included. Bernard's gateway is not a stock CRS setup either:
some rules it would have to enforce also match accepted requests.

The output contains rule ids, CRS patterns, counts, and words that occur in every rejected request but in no
accepted one; with --show also the lines of session content where a candidate matches. Read it before
sharing it.

Usage:
  git clone --depth 1 --branch v4.30.0 https://github.com/coreruleset/coreruleset crs
  python3 scripts/waf-compare.py crs/rules [sessions dir] [--paranoia N] [--show]

The sessions directory defaults to $PI_CODING_AGENT_DIR/sessions, or ~/.pi/agent/sessions.
"""
import argparse
import glob
import html
import json
import os
import re
import urllib.parse
from collections import Counter
from datetime import datetime

REJECTED_PREFIX = "Bernard-Gateway hat die Anfrage abgelehnt (HTTP 403)"
LEGACY_REJECTION = re.compile(r"^Bernard HTTP 403: \s*<")
# Pi's own rewrite of outgoing text (BLOCKED_JAVA_PACKAGE in extensions/bernard/index.ts). Accepted requests
# are compared as sent; matches in rejected requests that the rewrite removes are marked.
PI_REWRITE = re.compile(r"java\.lang\.(?=runtime|processbuilder)", re.IGNORECASE)


def sent(text):
    return PI_REWRITE.sub("", text)


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(part.get("text", "") for part in content or [] if part.get("type") == "text")


def message_text(message):
    role = message.get("role")
    if role in ("user", "toolResult", "custom"):
        return text_of(message.get("content"))
    if role == "bashExecution" and not message.get("excludeFromContext"):
        return f"{message.get('command', '')}\n{message.get('output', '')}"
    return None


def is_rejection(message):
    error = message.get("errorMessage") or ""
    return message.get("role") == "assistant" and message.get("stopReason") == "error" and (
        error.startswith(REJECTED_PREFIX) or bool(LEGACY_REJECTION.match(error)))


def is_reply(message):
    return message.get("role") == "assistant" and message.get("stopReason") not in ("error", "aborted")


def load_requests(sessions_dir):
    """Returns (rejected, accepted) as lists of {session, time, text}."""
    rejected, accepted = [], []
    for path in sorted(glob.glob(os.path.join(sessions_dir, "**", "*.jsonl"), recursive=True)):
        entries = {}
        with open(path, encoding="utf-8", errors="replace") as file:
            for line in file:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict) and entry.get("id"):
                    entries[entry["id"]] = entry
        for entry in entries.values():
            message = entry.get("message") or {}
            if entry.get("type") != "message" or message.get("provider") != "bernard":
                continue
            target = rejected if is_rejection(message) else accepted if is_reply(message) else None
            if target is None:
                continue
            # The request carried what was added since the previous reply or rejection; failed runs in between
            # (aborted, network errors) were replayed with it.
            texts, current = [], entries.get(entry.get("parentId"))
            while current:
                previous = current.get("message") or {}
                if current.get("type") == "message":
                    if is_reply(previous) or is_rejection(previous):
                        break
                    text = message_text(previous)
                    if text:
                        texts.append(text)
                current = entries.get(current.get("parentId"))
            if texts:
                target.append({"session": os.path.basename(os.path.dirname(path)), "time": entry.get("timestamp", ""),
                               "text": "\n".join(reversed(texts))})
    return rejected, accepted


def transform(text, names):
    for name in names:
        if name == "lowercase":
            text = text.lower()
        elif name in ("urlDecode", "urlDecodeUni"):
            text = urllib.parse.unquote(text)
        elif name == "htmlEntityDecode":
            text = html.unescape(text)
        elif name == "removeNulls":
            text = text.replace("\0", "")
        elif name == "compressWhitespace":
            text = re.sub(r"\s+", " ", text)
        elif name == "removeWhitespace":
            text = re.sub(r"\s+", "", text)
        elif name == "replaceComments":
            text = re.sub(r"/\*.*?(\*/|$)", " ", text, flags=re.S)
        elif name == "normalizePathWin":
            text = text.replace("\\", "/")
        elif name == "cmdLine":
            text = re.sub(r"[\\\"'^]", "", text.lower())
            text = re.sub(r"[,;]", " ", text)
            text = re.sub(r"\s+", " ", text)
            text = re.sub(r" (?=[/(])", "", text)
            text = re.sub(r"(?<=[/(]) ", "", text)
        # Other transformations (base64Decode, jsDecode, utf8toUnicode, ...) are left out.
    return text


def load_rules(rules_dir, paranoia):
    """Returns rules that inspect ARGS or REQUEST_BODY up to the given paranoia level, and the number skipped."""
    rules, skipped = [], 0
    for conf in sorted(glob.glob(os.path.join(rules_dir, "REQUEST-9*.conf"))):
        with open(conf, encoding="utf-8") as file:
            source = file.read().replace("\\\n", " ")
        for block in re.split(r"\n(?=SecRule )", source):
            rule_id = re.search(r"\bid:(\d+)", block)
            level = re.search(r"paranoia-level/(\d)", block)
            operator = re.match(r'SecRule\s+(\S+)\s+"@(rx|pm|pmf|pmFromFile) (.*?)(?<!\\)"\s', block)
            if not rule_id or not level or int(level.group(1)) > paranoia or not operator:
                continue
            targets, kind, argument = operator.groups()
            if not re.search(r"(^|\|)(ARGS|REQUEST_BODY)(\||$)", targets):
                continue
            argument = argument.replace('\\"', '"')
            if kind == "rx":
                try:
                    match = re.compile(argument.replace(r"\z", r"\Z")).search
                except re.error:
                    skipped += 1
                    continue
                patterns = None
            else:
                if kind == "pm":
                    patterns = argument.split()
                else:
                    patterns = []
                    for name in argument.split():
                        with open(os.path.join(rules_dir, name), encoding="utf-8") as file:
                            patterns += [line.strip() for line in file if line.strip() and not line.startswith("#")]
                patterns = sorted({pattern.lower(): pattern for pattern in patterns}.items())
                match = None
            message = re.search(r"msg:'([^']*)'", block)
            severity = re.search(r"severity:'(\w+)'", block)
            rules.append({
                "id": rule_id.group(1), "transforms": re.findall(r"\bt:(\w+)", block), "match": match,
                "patterns": patterns, "message": message.group(1) if message else "",
                "label": f"{severity.group(1) if severity else '?'}, PL{level.group(1)}" + (", chain" if re.search(r"\bchain\b", block) else ""),
            })
    return rules, skipped


def show_lines(text, needle_found, limit=3):
    lines = [line.strip() for line in text.splitlines() if needle_found(line)]
    for line in lines[:limit]:
        print(f"        > {line[:160]}")
    if len(lines) > limit:
        print(f"        > ... {len(lines) - limit} more")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("rules_dir", help="the rules directory of a CRS checkout")
    parser.add_argument("sessions_dir", nargs="?", default=os.path.join(
        os.environ.get("PI_CODING_AGENT_DIR") or os.path.expanduser("~/.pi/agent"), "sessions"))
    parser.add_argument("--paranoia", type=int, default=1, help="highest CRS paranoia level to check (default 1)")
    parser.add_argument("--show", action="store_true", help="print the lines where a candidate matches (session content)")
    args = parser.parse_args()
    if not glob.glob(os.path.join(args.rules_dir, "REQUEST-9*.conf")):
        parser.error(f"no CRS rule files (REQUEST-9*.conf) in {args.rules_dir}")

    rejected, accepted = load_requests(args.sessions_dir)
    print(f"Rejected requests: {len(rejected)}, accepted requests with content: {len(accepted)}")
    for number, request in enumerate(rejected, 1):
        try:
            when = datetime.fromisoformat(request["time"].replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M")
        except ValueError:
            when = request["time"] or "unknown time"
        print(f"  {number}. {when}, {request['session']}, {len(request['text']):,} characters")
    if not rejected:
        return

    rules, skipped = load_rules(args.rules_dir, args.paranoia)
    cache = {}

    def view(kind, index, text, transforms):
        key = (kind, index, tuple(transforms))
        if key not in cache:
            cache[key] = transform(text, transforms)
        return cache[key]

    accepted_texts = [sent(request["text"]) for request in accepted]
    print(f"\nCRS rules up to paranoia level {args.paranoia} that match rejected requests "
          f"({len(rules)} checked, {skipped} regexes skipped).")
    print("'accepted' counts the accepted requests that match too; Pi's rewrite is applied to them.")
    for rule in rules:
        transforms = rule["transforms"]
        if rule["patterns"] is None:
            found = lambda text: bool(rule["match"](text))
            checks = [(None, found)]
        else:
            checks = [(original, lambda text, pattern=pattern: pattern in text.lower()) for pattern, original in rule["patterns"]]
        printed_header = False
        for pattern, found in checks:
            hits = [number for number, request in enumerate(rejected, 1)
                    if found(view("rejected", number, request["text"], transforms))]
            if not hits:
                continue
            also = sum(found(view("accepted", index, text, transforms)) for index, text in enumerate(accepted_texts))
            removed = [number for number in hits
                       if not found(transform(sent(rejected[number - 1]["text"]), transforms))]
            notes = []
            if also == 0:
                notes.append("only in rejected")
            if removed:
                notes.append(f"Pi now removes it from {', '.join(map(str, removed))}")
            note = f"  <- {'; '.join(notes)}" if notes else ""
            if not printed_header:
                print(f"  {rule['id']} ({rule['label']}): {rule['message'][:90]}")
                printed_header = True
            label = f"{pattern!r}" if pattern is not None else "regex"
            print(f"      {label}: rejected {hits}, accepted {also}{note}")
            if args.show and also == 0:
                for number in hits:
                    print(f"      rejection {number}:")
                    show_lines(rejected[number - 1]["text"], lambda line: found(transform(line, transforms)))

    tokenize = lambda text: set(re.findall(r"[a-z_][a-z0-9_.$/:-]{3,}", re.sub(r"\s+", " ", text.lower())))
    if len(rejected) > 1:
        accepted_tokens = Counter()
        for text in accepted_texts:
            accepted_tokens.update(tokenize(text))
        shared = set.intersection(*(tokenize(request["text"]) for request in rejected))
        only = sorted(token for token in shared if accepted_tokens[token] == 0)
        print(f"\nWords in all {len(rejected)} rejected requests: {len(shared)}, never in an accepted request: {len(only)}")
        if only:
            print("  " + ", ".join(only[:80]))


if __name__ == "__main__":
    main()
