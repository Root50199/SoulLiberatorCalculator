import argparse
import hashlib
import json
import re
import sqlite3
import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from datetime import datetime, timezone
from fnmatch import fnmatchcase
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_DATABASE = PROJECT / "data" / "soul-liberator.sqlite"
SCHEMA = """
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items (
    item_id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_status TEXT NOT NULL,
    catalog_current INTEGER NOT NULL CHECK(catalog_current IN (0,1))
);
CREATE TABLE IF NOT EXISTS auction_house_prices (
    item_id INTEGER PRIMARY KEY REFERENCES items(item_id),
    gold_per_unit INTEGER CHECK(gold_per_unit IS NULL OR
        (typeof(gold_per_unit)='integer' AND gold_per_unit >= 0)),
    updated_at TEXT, notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS provenance (
    source_file TEXT PRIMARY KEY, sha256 TEXT NOT NULL, encoding TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS item_definitions (
    definition_key TEXT PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(item_id),
    source_file TEXT NOT NULL REFERENCES provenance(source_file),
    name_token TEXT, localized_name TEXT, category TEXT, feature TEXT,
    locale_status TEXT NOT NULL, gates_json TEXT NOT NULL,
    auction_search_locales TEXT
);
CREATE TABLE IF NOT EXISTS sl_items (
    item_id INTEGER PRIMARY KEY REFERENCES items(item_id)
);
CREATE TABLE IF NOT EXISTS recipes (
    recipe_key TEXT PRIMARY KEY, product_item_id INTEGER NOT NULL REFERENCES items(item_id),
    section TEXT NOT NULL, production_id INTEGER NOT NULL, production_type INTEGER NOT NULL,
    output_quantity INTEGER NOT NULL CHECK(output_quantity > 0),
    source_file TEXT NOT NULL REFERENCES provenance(source_file),
    source_record TEXT NOT NULL, feature TEXT, gates_json TEXT NOT NULL,
    availability TEXT NOT NULL DEFAULT 'client_observed_unverified_live'
);
CREATE TABLE IF NOT EXISTS recipe_ingredients (
    recipe_key TEXT NOT NULL REFERENCES recipes(recipe_key), position INTEGER NOT NULL,
    category_expression TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
    match_status TEXT NOT NULL,
    PRIMARY KEY(recipe_key,position)
);
CREATE TABLE IF NOT EXISTS ingredient_candidates (
    recipe_key TEXT NOT NULL, position INTEGER NOT NULL,
    item_id INTEGER NOT NULL REFERENCES items(item_id),
    PRIMARY KEY(recipe_key,position,item_id),
    FOREIGN KEY(recipe_key,position) REFERENCES recipe_ingredients(recipe_key,position)
);
CREATE TABLE IF NOT EXISTS sl_materials (
    sl_item_id INTEGER NOT NULL REFERENCES sl_items(item_id),
    material_item_id INTEGER NOT NULL REFERENCES items(item_id),
    minimum_depth INTEGER NOT NULL CHECK(minimum_depth > 0),
    PRIMARY KEY(sl_item_id,material_item_id)
);
CREATE TABLE IF NOT EXISTS acquisition_sources (
    source_key TEXT PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(item_id),
    kind TEXT NOT NULL CHECK(kind IN ('craft','shop','reward')),
    source_name TEXT NOT NULL, currency TEXT, currency_item_id INTEGER,
    price INTEGER CHECK(price IS NULL OR price >= 0),
    purchase_quantity INTEGER CHECK(purchase_quantity IS NULL OR purchase_quantity > 0),
    recipe_key TEXT REFERENCES recipes(recipe_key),
    source_file TEXT NOT NULL REFERENCES provenance(source_file),
    source_record TEXT NOT NULL, evidence TEXT NOT NULL, observed_at TEXT,
    availability TEXT NOT NULL, details_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recipe_product ON recipes(product_item_id);
CREATE INDEX IF NOT EXISTS acquisition_item ON acquisition_sources(item_id);
CREATE TABLE IF NOT EXISTS manual_sources (
    manual_id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(item_id),
    kind TEXT NOT NULL CHECK(kind IN ('craft','shop','reward','mob_drop','other')),
    source_name TEXT NOT NULL CHECK(length(trim(source_name)) > 0),
    currency TEXT CHECK(currency IS NULL OR length(trim(currency)) > 0),
    currency_item_id INTEGER REFERENCES items(item_id),
    price INTEGER CHECK(price IS NULL OR (typeof(price)='integer' AND price >= 0)),
    purchase_quantity INTEGER CHECK(purchase_quantity IS NULL OR
        (typeof(purchase_quantity)='integer' AND purchase_quantity > 0)),
    observed_at TEXT, notes TEXT NOT NULL DEFAULT '',
    CHECK(price IS NULL OR currency IS NOT NULL),
    CHECK(currency_item_id IS NULL OR currency='item'),
    CHECK(currency IS NULL OR currency!='item' OR currency_item_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS source_signatures (
    source_key TEXT PRIMARY KEY REFERENCES acquisition_sources(source_key),
    fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_exclusions (
    source_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
    excluded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS item_notes (
    note_key TEXT PRIMARY KEY CHECK(length(trim(note_key)) > 0),
    item_id INTEGER NOT NULL REFERENCES items(item_id),
    kind TEXT NOT NULL CHECK(kind IN ('naming','source','recipe','other')),
    status TEXT NOT NULL CHECK(status IN ('confirmed','reported','unverified')),
    title TEXT NOT NULL CHECK(length(trim(title)) > 0),
    message TEXT NOT NULL CHECK(length(trim(message)) > 0),
    observed_label TEXT, correct_label TEXT,
    evidence TEXT NOT NULL CHECK(length(trim(evidence)) > 0),
    observed_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
DROP VIEW IF EXISTS materials;
DROP VIEW IF EXISTS effective_sources;
DROP VIEW IF EXISTS exclusion_status;
CREATE VIEW effective_sources AS
SELECT a.*, 'auto' AS origin FROM acquisition_sources a
JOIN source_signatures f USING(source_key)
WHERE NOT EXISTS (SELECT 1 FROM source_exclusions e
                  WHERE e.source_key=a.source_key AND e.fingerprint=f.fingerprint)
UNION ALL
SELECT 'manual:' || manual_id, item_id, kind, source_name, currency, currency_item_id,
       price, purchase_quantity, NULL, 'user', CAST(manual_id AS TEXT), 'user_entered',
       observed_at, 'user_entered_unverified', json_object('notes',notes), 'manual'
FROM manual_sources;
CREATE TRIGGER IF NOT EXISTS delete_effective_source
INSTEAD OF DELETE ON effective_sources BEGIN
    UPDATE source_exclusions
    SET fingerprint=(SELECT fingerprint FROM source_signatures WHERE source_key=OLD.source_key),
        excluded_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE source_key=OLD.source_key AND OLD.origin='auto';
    INSERT OR IGNORE INTO source_exclusions(source_key,fingerprint)
    SELECT source_key,fingerprint FROM source_signatures
    WHERE source_key=OLD.source_key AND OLD.origin='auto';
    DELETE FROM manual_sources
    WHERE 'manual:' || manual_id=OLD.source_key AND OLD.origin='manual';
END;
CREATE VIEW exclusion_status AS
SELECT e.*, CASE WHEN f.source_key IS NULL THEN 'source_missing'
                WHEN e.fingerprint!=f.fingerprint THEN 'source_changed_review_needed'
                ELSE 'excluded' END AS status
FROM source_exclusions e LEFT JOIN source_signatures f USING(source_key);
CREATE VIEW materials AS
SELECT i.item_id, i.name, i.name_status, p.gold_per_unit AS auction_house_gold_per_unit,
       p.updated_at AS auction_house_updated_at, p.notes AS auction_house_notes,
       (SELECT count(*) FROM effective_sources s WHERE s.item_id=i.item_id) AS source_count,
       (SELECT count(*) FROM item_notes n WHERE n.item_id=i.item_id AND n.enabled=1) AS note_count
FROM items i JOIN auction_house_prices p USING(item_id)
WHERE i.catalog_current=1 AND i.item_id IN (SELECT material_item_id FROM sl_materials);
"""


def locale_status(gates: list[dict[str, str]], target: str = "usa") -> str:
    unresolved = False
    for gate in gates:
        for key in ("locale", "__locale"):
            expression = gate.get(key, "").strip()
            if not expression:
                continue
            if not re.fullmatch(r"[a-z]+(?:\s+[a-z]+)*", expression):
                unresolved = True
            elif target not in expression.split():
                return "excluded"
    return "unresolved" if unresolved else "eligible"


def walk_gated(element: ET.Element, ancestors: list[dict[str, str]] | None = None):
    gates = list(ancestors or [])
    gate = {k: v for k, v in element.attrib.items()
            if k.lower() in ("locale", "__locale", "feature", "__feature", "condition",
                             "basicevent", "event", "starttime", "endtime")}
    if gate:
        gates.append(gate)
    yield element, gates
    for child in element:
        yield from walk_gated(child, gates)


class ClientCatalog:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.provenance: dict[str, tuple[str, str]] = {}
        self.strings: dict[str, dict[str, str]] = {}
        self.items: dict[int, list[dict]] = defaultdict(list)
        self.recipes: dict[int, list[dict]] = defaultdict(list)
        self.candidate_cache: dict[str, list[int]] = {}

    def text(self, relative: str) -> str:
        raw = (self.root / relative).read_bytes()
        if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
            encoding = "utf-16"
        elif raw.startswith(b"\xef\xbb\xbf"):
            encoding = "utf-8-sig"
        else:
            encoding = "utf-8"
        self.provenance[relative] = (hashlib.sha256(raw).hexdigest(), encoding)
        return raw.decode(encoding)

    def xml(self, relative: str) -> ET.Element:
        return ET.fromstring(self.text(relative))

    def localize(self, token: str | None, *, allow_missing: bool = False) -> str | None:
        if not token:
            return None
        match = re.fullmatch(r"_LT\[xml\.(.+)\.(\d+)\]", token)
        if not match:
            return token
        family, key = match.groups()
        if family not in self.strings:
            values = {}
            for line in self.text(f"local\\xml\\{family}.english.txt").splitlines():
                parsed = re.match(r"^(\d+)\t(.*)$", line)
                if parsed:
                    number, value = parsed.groups()
                    if number in values:
                        raise ValueError(f"Duplicate localization key: {family}.{number}")
                    values[number] = value
            self.strings[family] = values
        if key not in self.strings[family]:
            if allow_missing:
                return None
            raise ValueError(f"Missing localization key: {family}.{key}")
        return self.strings[family][key]

    def load(self) -> None:
        files = sorted(f for f in (self.root / "db").iterdir()
                       if f.name.lower().startswith("itemdb") and f.suffix.lower() == ".xml")
        if not files:
            raise ValueError("No ItemDB XML sources found.")
        for file in files:
            source = f"db\\{file.name}"
            for ordinal, (row, gates) in enumerate(walk_gated(self.xml(source))):
                if row.tag != "Mabi_Item" or "ID" not in row.attrib:
                    continue
                status = locale_status(gates)
                if status == "excluded":
                    continue
                self.items[int(row.attrib["ID"])].append({
                    "key": f"{source}#{ordinal}", "source": source,
                    "token": row.get("Text_Name1"),
                    "name": self.localize(row.get("Text_Name1"), allow_missing=True),
                    "category": row.get("Category"), "feature": row.get("feature"),
                    "status": status, "gates": gates, "auction": row.get("AuctionSearchFlag"),
                })
        source = "db\\Production.xml"
        document = self.xml(source)
        for section in document:
            for ordinal, (row, gates) in enumerate(walk_gated(section)):
                if "ProductItemId" not in row.attrib or locale_status(gates) == "excluded":
                    continue
                a = row.attrib
                key = f"{section.tag}/{a['ProductionType']}/{a['ProductionId']}#{ordinal}"
                self.recipes[int(a["ProductItemId"])].append({
                    "key": key, "section": section.tag, "id": int(a["ProductionId"]),
                    "type": int(a["ProductionType"]), "output": int(a["ProductionCount"]),
                    "source": source, "record": f"{section.tag}#{ordinal}", "gates": gates,
                    "feature": a.get("Feature"), "essentials": a.get("Essentials", ""),
                })

    def ingredients(self, recipe: dict) -> list[tuple[str, int]]:
        ingredients = []
        for entry in recipe["essentials"].split(";"):
            if not entry.strip():
                continue
            parsed = re.fullmatch(r"\s*(.+?)\s*,\s*(\d+)\s*", entry)
            if not parsed or int(parsed[2]) <= 0:
                raise ValueError(f"Unsupported ingredient in {recipe['key']}: {entry}")
            ingredients.append((parsed[1], int(parsed[2])))
        return ingredients

    def candidates(self, expression: str) -> list[int]:
        if expression not in self.candidate_cache:
            # User excluded unused "(Temporary) Wool 2"; it is not a live material candidate.
            self.candidate_cache[expression] = sorted(
                item_id for item_id, definitions in self.items.items()
                if item_id != 90201 and any(d["category"] and fnmatchcase(
                    d["category"], expression if expression.startswith("*") else
                    f"*{expression}" if "*" in expression else f"*{expression}*")
                       for d in definitions))
        if not self.candidate_cache[expression]:
            raise ValueError(f"Unresolved ingredient category: {expression}")
        return self.candidate_cache[expression]

    def graph(self) -> tuple[list[int], dict[int, dict[int, int]], dict[str, dict]]:
        roots = sorted(item_id for item_id, rows in self.items.items()
                       if any(r["name"] and r["name"].startswith("Soul Liberator ") for r in rows))
        if not roots:
            raise ValueError("No localized Soul Liberator items found.")
        memberships = {}
        selected_recipes = {}
        for root in roots:
            if not self.recipes.get(root):
                raise ValueError(f"Soul Liberator item {root} has no Production recipe.")
            distances = {root: 0}
            queue = deque([root])
            while queue:
                product = queue.popleft()
                for recipe in self.recipes.get(product, []):
                    ingredients = self.ingredients(recipe)
                    selected_recipes[recipe["key"]] = {
                        **recipe, "product": product, "ingredients": ingredients}
                    for expression, _ in ingredients:
                        for material in self.candidates(expression):
                            if material not in distances:
                                distances[material] = distances[product] + 1
                                queue.append(material)
            memberships[root] = {item: depth for item, depth in distances.items() if depth > 0}
        return roots, memberships, selected_recipes


def source_rows(catalog: ClientCatalog, selected: set[int], recipes: dict[str, dict],
                audit: Path) -> list[dict]:
    sources = []
    selected_strings = {str(i) for i in selected}

    def add(key: str, item: int, kind: str, name: str, file: str, record: str,
            *, price: int | None = None, currency: str | None = None,
            currency_item: int | None = None, quantity: int | None = None,
            recipe: str | None = None, evidence: str = "client_table",
            availability: str = "client_observed_unverified_live", details=None):
        sources.append(dict(key=key, item=item, kind=kind, name=name, file=file, record=record,
                            price=price, currency=currency, currency_item=currency_item,
                            quantity=quantity, recipe=recipe, evidence=evidence,
                            availability=availability, details=details or {}))

    for key, recipe in recipes.items():
        add(f"craft:{key}", recipe["product"], "craft", recipe["section"],
            recipe["source"], recipe["record"], quantity=recipe["output"],
            recipe=key, details={"gates": recipe["gates"]})

    for filename, tag, id_key in (("db\\NPCShop\\NPCShop.xml", "Product", "ProductId"),
                                   ("db\\PawnShop.xml", "Item", "id")):
        document = catalog.xml(filename)
        tabs = defaultdict(list)
        for tab in document.iter("Tab"):
            tabs[tab.get("TabId")].append(dict(tab.attrib))
        for ordinal, (row, gates) in enumerate(walk_gated(document)):
            if row.tag != tag or row.get(id_key, "") not in selected_strings:
                continue
            if locale_status(gates) == "excluded":
                continue
            a = row.attrib
            if tag == "Product" and a.get("ProductType") != "item":
                continue
            name = a.get("array_name", "Unresolved NPC shop")
            matches = tabs.get(a.get("TabId"), [])
            shop_names = sorted({t["ShopName"] for t in matches})
            if shop_names:
                name = " / ".join(shop_names)
            add(f"shop:{filename}#{ordinal}", int(a[id_key]), "shop", name, filename,
                str(ordinal), price=int(a["Price"] if tag == "Product" else a["pawn"]),
                currency=a.get("PriceType", "pawn"),
                currency_item=int(a["PriceValue"]) if a.get("PriceType") == "item" else None,
                quantity=int(a["Bundle"]) if a.get("Bundle") else None,
                availability="unresolved_shop_gates_and_limits",
                details={"gates": gates, "tab_candidates": matches,
                         "stock": a.get("Stock"), "personal_stock": a.get("PersonalStock"),
                         "reset": a.get("PersonalStockDeed"), "daylimit": a.get("daylimit"),
                         "arguments": a.get("Arguments")})

    filename = "db\\ContentsRewardTableClient.xml"
    document = catalog.xml(filename)
    guide = catalog.xml("db\\DungeonGuide2025.xml")
    groups = {}
    for row, gates in walk_gated(guide):
        if row.tag == "Group" and locale_status(gates) != "excluded":
            groups[row.get("DungeonGroupID")] = row.get("LocalName")
    content_names = defaultdict(set)
    for row, gates in walk_gated(guide):
        if row.tag == "Detail" and locale_status(gates) != "excluded":
            name = catalog.localize(row.get("LocalDungeonName") or groups.get(row.get("DungeonGroupID")))
            difficulty = catalog.localize(row.get("LocalDifficulty"))
            if name in {"Normal", "Basic", "Intermediate", "Advanced", "Hard", "Elite", "Veteran"}:
                name, difficulty = difficulty, name
            for difficulty_id in row.get("Dungeon2Difficulty", "").split(";"):
                key = (row.get("DungeonIDStr", "").casefold(), difficulty_id)
                content_names[key].add((name, difficulty))
    pools = defaultdict(list)
    contents = document.find("ContentsList")
    if contents is None:
        raise ValueError("Missing ContentsList in reward source.")
    for content in contents:
        for difficulty in content:
            for pool in difficulty:
                names = content_names.get((content.get("id", "").casefold(), difficulty.get("difficultyId")), set())
                localized = next(iter(names)) if len(names) == 1 else (None, None)
                pools[pool.get("rewardPoolId")].append({
                    "content_id": content.get("id"), "content_description": content.get("desc"),
                    "localized_name": localized[0], "localized_difficulty": localized[1],
                    "name_status": "resolved" if localized[0] else "unresolved_content_localization",
                    "difficulty": difficulty.get("difficultyId"),
                    "content_gates": {k: v for k, v in content.attrib.items() if k != "desc"},
                    "difficulty_gates": dict(difficulty.attrib), "pool_gates": dict(pool.attrib),
                })
    pool_list = document.find("RewardPoolList")
    if pool_list is None:
        raise ValueError("Missing RewardPoolList in reward source.")
    for pool_ordinal, pool in enumerate(pool_list):
        for ordinal, row in enumerate(pool.iter("Reward")):
            if row.get("type") != "1" or row.get("rewardId", "") not in selected_strings:
                continue
            quantity_match = re.fullmatch(r"count:(\d+)", row.get("argument", ""))
            add(f"reward:{pool_ordinal}:{ordinal}", int(row.attrib["rewardId"]), "reward",
                f"Reward pool {pool.get('id')}", filename, f"pool#{pool_ordinal}/reward#{ordinal}",
                quantity=int(quantity_match[1]) if quantity_match else None,
                availability="drop_probability_and_live_availability_unknown",
                details={"pool_id": pool.get("id"), "pool_attributes": dict(pool.attrib),
                         "reward_attributes": dict(row.attrib), "contents": pools[pool.get("id")]})

    report = audit.read_bytes()
    filename = audit.name
    catalog.provenance[filename] = (hashlib.sha256(report).hexdigest(), "utf-8")
    listing_rows = []
    for line_number, line in enumerate(report.decode("utf-8").splitlines(), 1):
        match = re.fullmatch(r"\| (.+) \| (\d+) \| ([\d,]+) (gold|Obols?) \|", line)
        if match:
            listing_rows.append((line_number, match))
    if len(listing_rows) != 32:
        raise ValueError(f"Expected 32 audited screenshot offers, found {len(listing_rows)}.")
    for line_number, match in listing_rows:
        item = int(match[2])
        if item not in selected:
            continue
        is_gold = match[4] == "gold"
        add(f"leannan:{item}", item, "shop", "Leannan", filename, f"line {line_number}",
            price=int(match[3].replace(",", "")), currency="gold" if is_gold else "item",
            currency_item=None if is_gold else 5300217,
            quantity=1,
            evidence="user_screenshot_2026-11-05",
            availability="user_confirmed_unit_purchase_live_access_unverified",
            details={"displayed_name": match[1], "npc_id": 50219,
                     "purchase_quantity": "user confirmed 1 per purchase, 2026-11-05",
                     "stock_reset": "unverified; shown elixir weekly limit is irrelevant to SL materials"})
    return sources


def build_database(root: Path, output: Path, audit: Path) -> dict[str, int]:
    root, output = root.resolve(), output.resolve()
    if output.is_relative_to(root):
        raise ValueError("Database output must not be inside the read-only client dump.")
    catalog = ClientCatalog(root)
    catalog.load()
    roots, memberships, recipes = catalog.graph()
    materials = {item for members in memberships.values() for item in members}
    selected = set(roots) | materials
    sources = source_rows(catalog, selected, recipes, audit)
    currency_ids = {s["currency_item"] for s in sources if s["currency_item"] is not None}
    selected |= currency_ids
    if selected - catalog.items.keys():
        raise ValueError(f"Missing item definitions: {sorted(selected - catalog.items.keys())}")
    output.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(output)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1, 2, 3, 4):
            raise ValueError(f"Unsupported material database schema version: {version}")
        if version == 0 and connection.execute(
                "SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]:
            raise ValueError("Refusing to modify an existing unrelated database.")
        migrate_manual = version in (1, 2, 3) and connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='manual_sources'").fetchone()
        migration = """
            DROP VIEW IF EXISTS materials;
            DROP VIEW IF EXISTS effective_sources;
            ALTER TABLE manual_sources RENAME TO manual_sources_v3;
        """ if migrate_manual else ""
        connection.executescript("BEGIN IMMEDIATE;\n" + migration + SCHEMA)
        if migrate_manual:
            connection.execute("INSERT INTO manual_sources SELECT * FROM manual_sources_v3")
            connection.execute("DROP TABLE manual_sources_v3")
        for table in ("source_signatures", "acquisition_sources", "ingredient_candidates", "recipe_ingredients",
                      "sl_materials", "recipes", "sl_items", "item_definitions", "provenance"):
            connection.execute(f"DELETE FROM {table}")
        connection.execute("UPDATE items SET catalog_current=0")
        for source, (digest, encoding) in catalog.provenance.items():
            connection.execute("INSERT INTO provenance VALUES (?,?,?)", (source, digest, encoding))
        for item in sorted(selected):
            names = list(dict.fromkeys(d["name"] for d in catalog.items[item] if d["name"]))
            if item in roots:
                names.sort(key=lambda name: not name.startswith("Soul Liberator "))
            name_status = ("missing_localization" if not names else
                           "resolved" if len(names) == 1 else "conflicting_source_names")
            connection.execute(
                "INSERT INTO items VALUES (?,?,?,1) ON CONFLICT(item_id) DO UPDATE SET "
                "name=excluded.name,name_status=excluded.name_status,catalog_current=1",
                (item, names[0] if names else f"Unresolved item {item}", name_status))
            connection.execute("INSERT OR IGNORE INTO auction_house_prices(item_id) VALUES (?)", (item,))
            for d in catalog.items[item]:
                connection.execute("INSERT INTO item_definitions VALUES (?,?,?,?,?,?,?,?,?,?)",
                                   (d["key"], item, d["source"], d["token"], d["name"], d["category"],
                                    d["feature"], d["status"], json.dumps(d["gates"]), d["auction"]))
        connection.executemany("INSERT INTO sl_items VALUES (?)", [(i,) for i in roots])
        for sl_root, members in memberships.items():
            connection.executemany("INSERT INTO sl_materials VALUES (?,?,?)",
                                   [(sl_root, item, depth) for item, depth in members.items()])
        for key, r in recipes.items():
            connection.execute(
                "INSERT INTO recipes(recipe_key,product_item_id,section,production_id,production_type,"
                "output_quantity,source_file,source_record,feature,gates_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (key, r["product"], r["section"], r["id"], r["type"], r["output"], r["source"],
                 r["record"], r["feature"], json.dumps(r["gates"])))
            for position, (expression, quantity) in enumerate(r["ingredients"], 1):
                connection.execute("INSERT INTO recipe_ingredients VALUES (?,?,?,?,?)",
                                   (key, position, expression, quantity,
                                    "wildcard_category_candidate" if expression.startswith("*") else
                                    "category_fragment_candidate_unverified"))
                connection.executemany("INSERT INTO ingredient_candidates VALUES (?,?,?)",
                                       [(key, position, i) for i in catalog.candidates(expression)])
        for s in sources:
            connection.execute("INSERT INTO acquisition_sources VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                               (s["key"], s["item"], s["kind"], s["name"], s["currency"],
                                s["currency_item"], s["price"], s["quantity"], s["recipe"], s["file"],
                                s["record"], s["evidence"],
                                "2026-11-05" if s["evidence"].startswith("user_screenshot") else None,
                                s["availability"], json.dumps(s["details"], ensure_ascii=True)))
            fingerprint = hashlib.sha256(json.dumps(
                s, sort_keys=True, ensure_ascii=True).encode("utf-8")).hexdigest()
            connection.execute("INSERT INTO source_signatures VALUES (?,?)", (s["key"], fingerprint))
        if 63385 in selected:
            connection.execute("""
                INSERT INTO item_notes(note_key,item_id,kind,status,title,message,
                                       observed_label,correct_label,evidence,observed_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(note_key) DO NOTHING
            """, (
                "melodic-metal-plate-craft-label", 63385, "naming", "confirmed",
                "Incorrect material name in the crafting window",
                "The Soul Liberator Lyre crafting window calls this material "
                "'Melodic Metal Board'. The correct item name is 'Melodic Metal Plate'. "
                "Both labels refer to item 63385, not two different materials.",
                "Melodic Metal Board", "Melodic Metal Plate",
                "User lyre screenshot and correction, 2026-11-05; "
                "Carpentry/10/33, production.6649; item 63385 English localization. "
                "See CLIENT_DATA_CONTEXT.md.", "2026-11-05",
            ))
        for key, value in {
            "generated_at": datetime.now(timezone.utc).isoformat(), "data_root": "external-client-data/data",
            "target_locale": "usa", "coverage": "All localized client SL roots; recursive Production "
            "category alternatives; feature activation/duplicate precedence/live rules unresolved",
            "source_coverage": "Production, NPCShop, PawnShop, ContentsRewardTableClient, Leannan screenshot",
            "auction_price_unit": "User-entered gold per individual item; NULL means unknown",
        }.items():
            connection.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (key, value))
        connection.execute("PRAGMA user_version=4")
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Foreign key validation failed.")
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Database integrity validation failed.")
        connection.commit()
        counts = {"sl_items": len(roots), "materials": len(materials),
                  "recipes": len(recipes), "sources": len(sources)}
        uncertainties = connection.execute(
            "SELECT name_status,count(*) FROM items WHERE catalog_current=1 AND name_status!='resolved'"
            " GROUP BY name_status").fetchall()
        if uncertainties:
            print("Catalog name uncertainties: " + json.dumps(dict(uncertainties)))
        exclusion_warnings = connection.execute(
            "SELECT source_key,status FROM exclusion_status WHERE status!='excluded'").fetchall()
        if exclusion_warnings:
            print("Source exclusions need review: " + json.dumps(exclusion_warnings))
        return counts
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build SL SQLite catalog; preserve user AH prices.")
    parser.add_argument("--output", type=Path, default=DEFAULT_DATABASE)
    args = parser.parse_args()
    config = json.loads((PROJECT / "client-data.config.json").read_text(encoding="utf-8"))
    value = config.get("dataRoot")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("client-data.config.json requires a non-empty dataRoot.")
    print(json.dumps(build_database(PROJECT / value, args.output, PROJECT / "SHOP_SOURCE_AUDIT.md")))
