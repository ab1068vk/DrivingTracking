#!/usr/bin/env python3
"""Fail CI when Android certificate pins are missing or close to expiry."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import sys
import xml.etree.ElementTree as ET


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check Android network-security-config pin-set expiration dates."
    )
    parser.add_argument("config", help="Path to network_security_config.xml")
    parser.add_argument(
        "min_days",
        type=int,
        help="Fail when a pin-set expires within this many days.",
    )
    return parser.parse_args()


def parse_expiration(value: str | None, domains: str) -> dt.date | None:
    if not value:
        print(f"FAIL: {domains} pin-set is missing expiration.", file=sys.stderr)
        return None
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        print(f"FAIL: {domains} pin-set has invalid expiration: {value}", file=sys.stderr)
        return None


def valid_pin(value: str) -> bool:
    upper = value.upper()
    if "PIN" in upper or "PLACEHOLDER" in upper or value.strip().endswith("_ORG="):
        return False
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception:
        return False
    return len(decoded) == 32


def main() -> int:
    args = parse_args()
    today = dt.datetime.now(dt.UTC).date()
    threshold = today + dt.timedelta(days=args.min_days)
    root = ET.parse(args.config).getroot()
    failures: list[str] = []
    checked = 0

    for domain_config in root.findall("domain-config"):
        domains = ", ".join(
            domain.text.strip()
            for domain in domain_config.findall("domain")
            if domain.text and domain.text.strip()
        ) or "<unknown domain>"
        pin_sets = domain_config.findall("pin-set")
        if not pin_sets:
            failures.append(f"{domains}: missing pin-set")
            continue

        for pin_set in pin_sets:
            checked += 1
            expires = parse_expiration(pin_set.get("expiration"), domains)
            if expires is None:
                failures.append(f"{domains}: invalid expiration")
            elif expires <= threshold:
                days_left = (expires - today).days
                failures.append(
                    f"{domains}: pin-set expires on {expires.isoformat()} "
                    f"({days_left} days left, minimum {args.min_days})"
                )

            pins = [
                (pin.text or "").strip()
                for pin in pin_set.findall("pin")
                if pin.get("digest") == "SHA-256"
            ]
            if len(pins) < 2:
                failures.append(f"{domains}: expected at least two SHA-256 pins")
            for pin in pins:
                if not valid_pin(pin):
                    failures.append(f"{domains}: invalid or placeholder SHA-256 pin: {pin}")

    if checked == 0:
        failures.append("no pin-set entries found")

    if failures:
        print("Certificate pin check failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print(
        f"Certificate pin check passed: {checked} pin-set(s), "
        f"all expire after {threshold.isoformat()}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
