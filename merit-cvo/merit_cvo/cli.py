"""merit-cvo CLI — verify a citation from the terminal or a pipeline / CI gate."""
from __future__ import annotations

import argparse
import json
import sys

from .engine import verify_citation


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="merit-cvo", description="Citation Verification Oracle — is a claim actually supported by its source?")
    sub = p.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("verify", help="verify a single (claim, source) pair")
    v.add_argument("--claim", required=True)
    v.add_argument("--source", required=True)
    v.add_argument("--strict", action="store_true", help="require every model leg (NLI + judge) to confirm")
    v.add_argument("--nli-url", default=None, help="NLI backend URL (else MERIT_NLI_URL / MERIT_NLI_MODEL)")
    v.add_argument("--json", action="store_true", help="print the full verdict as JSON")

    args = p.parse_args(argv)
    if args.cmd == "verify":
        res = verify_citation(args.claim, args.source, strict=args.strict, nli_url=args.nli_url)
        if args.json:
            print(json.dumps(res.to_dict(), indent=2))
        elif not res.ok():
            print(f"ABSTAIN ({res.status}): {res.error}")
        else:
            print(f"{res.verdict}  [{'+'.join(res.methods)}]  {res.reason}")
        # exit code: 0 = SUPPORTED, 1 = REFUSED, 2 = abstained — usable as a CI gate
        return 0 if (res.ok() and res.verdict == "SUPPORTED") else (2 if not res.ok() else 1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
