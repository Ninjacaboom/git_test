#!/usr/bin/env python3
"""
Nova Tools data refresh script.

The NovaSCDataExtractor (sibling project) drops Live.zip and PTU.zip into
data/. This script reads those archives, refreshes data/versions.json with
each channel's current gameVersion (from the embedded metadata.json), and
fetches sold/shop status from finder.cstone.space.

It does NOT pull anything from spviewer.eu - that data source has been
retired in favour of our own extractor.
"""

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from html.parser import HTMLParser

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
ZIP_FILES = ["Live.zip", "PTU.zip"]


def file_sha256(path):
    """Return SHA-256 hex of a file, or None if it can't be read."""
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except (FileNotFoundError, PermissionError):
        return None


def read_metadata(zip_path):
    """Read metadata.json from inside a NovaSCDataExtractor archive.

    Returns the parsed dict, or None if the file is missing / unreadable /
    doesn't contain metadata.json.
    """
    try:
        with zipfile.ZipFile(zip_path) as zf:
            with zf.open("metadata.json") as f:
                return json.loads(f.read().decode("utf-8-sig"))
    except (FileNotFoundError, KeyError, zipfile.BadZipFile, json.JSONDecodeError) as e:
        print(f"    WARNING: could not read metadata from {os.path.basename(zip_path)}: {e}")
        return None


def update_versions():
    """Refresh data/versions.json from the local extractor archives.

    For each channel ZIP that exists, record gameVersion + buildVersion +
    extractionTimestamp + sha256. Channels whose ZIP is absent are dropped
    from versions.json so the build toggle disables them.
    """
    print("=== Step 1: Read extractor metadata ===")
    versions = {}

    for name in ZIP_FILES:
        zip_path = os.path.join(DATA_DIR, name)
        if not os.path.exists(zip_path):
            print(f"  {name}: not present (channel unavailable)")
            continue

        meta = read_metadata(zip_path)
        if not meta:
            continue

        sha = file_sha256(zip_path)
        entry = {
            "gameVersion": meta.get("gameVersion", ""),
            "buildVersion": meta.get("buildVersion", ""),
            "extractionTimestamp": meta.get("extractionTimestamp", ""),
            "sha256": sha,
        }
        versions[name] = entry
        print(f"  {name}: {entry['gameVersion']} (build {entry['buildVersion']})")

    versions_path = os.path.join(DATA_DIR, "versions.json")
    with open(versions_path, "w") as f:
        json.dump(versions, f, indent=2)
    print(f"  Saved {versions_path}")
    return versions


# --- CStone shop / sold-status fetch (unchanged behaviour) ---


class ShopTableParser(HTMLParser):
    """Parse shop location/price table from CStone detail pages."""
    def __init__(self):
        super().__init__()
        self.shops = []
        self._in_table = False
        self._in_row = False
        self._in_cell = False
        self._cells = []
        self._cell_text = ''

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self._in_table = True
        elif self._in_table and tag == 'tr':
            self._in_row = True
            self._cells = []
        elif self._in_row and tag == 'td':
            self._in_cell = True
            self._cell_text = ''

    def handle_endtag(self, tag):
        if tag == 'td' and self._in_cell:
            self._in_cell = False
            self._cells.append(self._cell_text.strip())
        elif tag == 'tr' and self._in_row:
            self._in_row = False
            # Expect: [location, price, verified_date]
            if len(self._cells) >= 2:
                loc = self._cells[0]
                price_str = self._cells[1].replace('\xa0', '').replace(' ', '').replace(',', '')
                # Only include rows that look like shop locations (contain " - ")
                if ' - ' in loc:
                    try:
                        price = int(price_str)
                        self.shops.append({'location': loc, 'price': price})
                    except ValueError:
                        pass  # header row or non-numeric
        elif tag == 'table':
            self._in_table = False

    def handle_data(self, data):
        if self._in_cell:
            self._cell_text += data


def fetch_shop_data(detail_url):
    """Fetch shop locations and prices from a CStone detail page."""
    try:
        req = urllib.request.Request(detail_url, headers={"User-Agent": "Mozilla/5.0"})
        response = urllib.request.urlopen(req, timeout=15)
        html = response.read().decode('utf-8')
        parser = ShopTableParser()
        parser.feed(html)
        return parser.shops
    except Exception:
        return []


def fetch_sold_status():
    """Fetch sold/purchasable status and shop data from finder.cstone.space."""
    # API endpoint -> (label, detail page prefix)
    endpoints = {
        'GetCoolers':    ('coolers',      'ShipCoolers1'),
        'GetPowers':     ('powerplants',  'ShipPowerPlants1'),
        'GetDrives':     ('quantumdrives','JumpDrives1'),
        'GetShields':    ('shields',      'ShipShields1'),
        'GetSWeapons':   ('weapons',      'ShipWeapons1'),
        'GetSTurrets':   ('turrets',      'ShipTurrets1'),
        'GetShipModule': ('modules',      'ShipModule1'),
    }

    sold_map = {}
    shop_map = {}  # className -> [{location, price}, ...]
    sold_items = []  # (className, itemId, detailPrefix) for items we need shop data for

    for endpoint, (label, detail_prefix) in endpoints.items():
        url = f"https://finder.cstone.space/{endpoint}"
        print(f"  Fetching {label} from {url}...")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            response = urllib.request.urlopen(req, timeout=15)
            data = json.loads(response.read().decode('utf-8'))
            count_sold = 0
            for item in data:
                code = item.get('ItemCodeName', '')
                sold = item.get('Sold', 0)
                item_id = item.get('ItemId', '')
                if code:
                    sold_map[code] = sold
                    if sold and item_id:
                        count_sold += 1
                        sold_items.append((code, item_id, detail_prefix))
            print(f"    {len(data)} items, {count_sold} purchasable")
        except Exception as e:
            print(f"    WARNING: Failed to fetch {label}: {e}")

    out_path = os.path.join(DATA_DIR, "sold_status.json")
    with open(out_path, 'w') as f:
        json.dump(sold_map, f)
    print(f"  Saved {out_path} ({len(sold_map)} items)")

    # Fetch shop locations/prices for sold items
    print(f"\n  Fetching shop data for {len(sold_items)} sold items...")
    fetched = 0
    for code, item_id, prefix in sold_items:
        detail_url = f"https://finder.cstone.space/{prefix}/{item_id}"
        shops = fetch_shop_data(detail_url)
        if shops:
            shop_map[code] = shops
            fetched += 1
        # Small delay to be respectful to the server
        time.sleep(0.15)
        if (fetched % 25 == 0 and fetched > 0):
            print(f"    ... {fetched} items with shop data so far")

    shop_path = os.path.join(DATA_DIR, "shop_data.json")
    with open(shop_path, 'w') as f:
        json.dump(shop_map, f)
    print(f"  Saved {shop_path} ({len(shop_map)} items with shop data)")


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    versions = update_versions()
    if not versions:
        print("\nERROR: No NovaSCDataExtractor archives found in data/.")
        print("Drop Live.zip and/or PTU.zip into the data/ folder and re-run.")
        sys.exit(1)

    print("\n=== Step 2: Fetch sold status from CStone ===")
    fetch_sold_status()

    print("\nDone! Data files are ready in ./data/")


if __name__ == "__main__":
    main()
