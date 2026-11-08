import sqlite3
import json
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from build_material_database import DEFAULT_DATABASE, ClientCatalog, build_database, locale_status


class MaterialDatabaseTests(unittest.TestCase):
    def test_unused_test_wool_is_not_a_candidate(self):
        catalog = ClientCatalog(self.root)
        catalog.load()
        catalog.items[90201] = [{"category": "/material/leaf/"}]
        self.assertNotIn(90201, catalog.candidates("*/leaf/*"))

    def test_exploration_sourced_event_items_are_not_candidates(self):
        catalog = ClientCatalog(self.root)
        catalog.load()
        event_ids = range(5100175, 5100180)
        for item_id in event_ids:
            catalog.items[item_id] = [{"category": "/material/leaf/"}]
        candidates = catalog.candidates("*/leaf/*")
        self.assertTrue(set(event_ids).isdisjoint(candidates))
        self.assertIn(3, candidates)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "client"
        self.output = self.base / "materials.sqlite"
        self.audit = self.base / "SHOP_SOURCE_AUDIT.md"
        self.write("db\\DungeonGuide2025.xml", """<Guide><Group DungeonGroupID="1"
          LocalName="_LT[xml.dungeonguide2025.5]"/><Detail DungeonGroupID="1"
          DungeonIDStr="DUNGEON" Dungeon2Difficulty="2" LocalDifficulty="_LT[xml.dungeonguide2025.9]"/></Guide>""")
        self.write("local\\xml\\dungeonguide2025.english.txt", "9\tNormal\n5\tTest dungeon\n")
        self.write("db\\ItemDB.xml", """<Items>
          <Mabi_Item ID="1" Category="/weapon/" Text_Name1="_LT[xml.itemdb.50]"/>
          <Mabi_Item ID="2" Category="/material/intermediate/" Text_Name1="_LT[xml.itemdb.20]"/>
          <Mabi_Item ID="3" Category="/material/leaf/" Text_Name1="_LT[xml.itemdb.90]"/>
          <Mabi_Item ID="3" feature="new" Text_Name1="_LT[xml.itemdb.91]"/>
          <Mabi_Item ID="4" Category="/material/leaf/event/" Text_Name1="_LT[xml.itemdb.7]"/>
          <Group locale="korea"><Mabi_Item ID="5" Category="/material/leaf/"
              Text_Name1="Excluded item"/></Group>
        </Items>""")
        self.write("local\\xml\\itemdb.english.txt",
                   "90\tBase material\n50\tSoul Liberator Test\n20\tIntermediate\n"
                   "91\tBase material\n7\tEvent material\n", "utf-8-sig")
        self.write("db\\Production.xml", """<Production><MagicCraft>
          <Production ProductionId="1" ProductionType="14" ProductItemId="1"
              ProductionCount="1" Essentials="*/intermediate/*,3"/>
          <Production ProductionId="2" ProductionType="14" ProductItemId="2"
              ProductionCount="2" Essentials="*/leaf/*,5"/>
          <Production ProductionId="3" ProductionType="14" ProductItemId="2"
              ProductionCount="1" Essentials="*/leaf/*,2"/>
        </MagicCraft></Production>""")
        self.write("db\\NPCShop\\NPCShop.xml", """<NPCShop><ShopTab>
          <Tab ShopName="Test shop" TabId="1"/>
        </ShopTab><ShopProduct><Product TabId="1" ProductType="item"
          ProductId="3" PriceType="gold" Price="100" Bundle="5"/>
        </ShopProduct></NPCShop>""")
        self.write("db\\PawnShop.xml", "<PawnShop><NpcShopList/></PawnShop>")
        self.write("db\\ContentsRewardTableClient.xml", """<ContentsDrop><ContentsList>
          <Contents id="dungeon"><Difficulty difficultyId="2">
            <RewardPool rewardPoolId="77"/></Difficulty></Contents>
          </ContentsList><RewardPoolList><RewardPool id="77">
            <Reward type="1" rewardId="3" argument="count:2"/>
          </RewardPool></RewardPoolList></ContentsDrop>""")
        self.audit.write_text("\n".join(
            f"| Unrelated item | {100 + i} | 3 Obols |" for i in range(32)), encoding="utf-8")

    def write(self, relative, text, encoding="utf-16"):
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding=encoding)

    def build(self):
        return build_database(self.root, self.output, self.audit)

    def test_reward_names_use_explicit_content_and_localization_keys(self):
        self.build()
        with closing(sqlite3.connect(self.output)) as db:
            details = json.loads(db.execute(
                "SELECT details_json FROM acquisition_sources WHERE kind='reward'").fetchone()[0])
            content = details["contents"][0]
            self.assertEqual(content["localized_name"], "Test dungeon")
            self.assertEqual(content["localized_difficulty"], "Normal")
            self.assertEqual(content["name_status"], "resolved")

    def test_unmatched_reward_content_remains_explicitly_unresolved(self):
        self.write("db\\DungeonGuide2025.xml", "<Guide/>")
        self.build()
        with closing(sqlite3.connect(self.output)) as db:
            details = json.loads(db.execute(
                "SELECT details_json FROM acquisition_sources WHERE kind='reward'").fetchone()[0])
            self.assertIsNone(details["contents"][0]["localized_name"])
            self.assertEqual(details["contents"][0]["name_status"], "unresolved_content_localization")

    def test_reversed_mission_fields_and_multiple_difficulty_ids(self):
        self.write("db\\DungeonGuide2025.xml", """<Guide><Detail DungeonIDStr="dungeon"
          Dungeon2Difficulty="2;99" LocalDungeonName="Hard" LocalDifficulty="Feth Fiada"/></Guide>""")
        self.build()
        with closing(sqlite3.connect(self.output)) as db:
            details = json.loads(db.execute(
                "SELECT details_json FROM acquisition_sources WHERE kind='reward'").fetchone()[0])
            self.assertEqual(details["contents"][0]["localized_name"], "Feth Fiada")
            self.assertEqual(details["contents"][0]["localized_difficulty"], "Hard")

    def test_complete_graph_alternatives_sources_and_unknown_prices(self):
        counts = self.build()
        self.assertEqual(counts, {"sl_items": 1, "materials": 3, "recipes": 3, "sources": 5})
        with closing(sqlite3.connect(self.output)) as db, db:
            self.assertEqual(db.execute("SELECT count(*) FROM materials").fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT count(*) FROM item_definitions WHERE item_id=3")
                             .fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT count(*) FROM ingredient_candidates WHERE item_id=5")
                             .fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT price,purchase_quantity FROM acquisition_sources "
                                        "WHERE kind='shop'").fetchone(), (100, 5))
            self.assertEqual(db.execute("SELECT count(*) FROM auction_house_prices "
                                        "WHERE gold_per_unit IS NOT NULL").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT name FROM items WHERE item_id=3").fetchone()[0],
                             "Base material")
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(db.execute("SELECT value FROM metadata WHERE key='data_root'")
                             .fetchone()[0], "external-client-data/data")

    def test_refresh_preserves_user_prices_and_rejects_invalid_prices(self):
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            db.execute("UPDATE auction_house_prices SET gold_per_unit=1234,"
                       "updated_at='2026-11-05',notes='manual' WHERE item_id=3")
            for invalid in (-1, 1.25, "unknown"):
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("UPDATE auction_house_prices SET gold_per_unit=? WHERE item_id=3",
                               (invalid,))
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            self.assertEqual(db.execute("SELECT gold_per_unit,updated_at,notes "
                                        "FROM auction_house_prices WHERE item_id=3").fetchone(),
                             (1234, "2026-11-05", "manual"))

    def test_missing_category_aborts_without_mutating_existing_database(self):
        self.build()
        before = self.output.read_bytes()
        self.write("db\\Production.xml", """<Production><MagicCraft>
          <Production ProductionId="1" ProductionType="14" ProductItemId="1"
              ProductionCount="1" Essentials="*/missing/*,3"/>
        </MagicCraft></Production>""")
        with self.assertRaisesRegex(ValueError, "Unresolved ingredient"):
            self.build()
        self.assertEqual(before, self.output.read_bytes())

    def test_source_output_guard_and_unrelated_database_guard(self):
        with self.assertRaisesRegex(ValueError, "read-only client dump"):
            build_database(self.root, self.root / "bad.sqlite", self.audit)
        with closing(sqlite3.connect(self.output)) as db, db:
            db.execute("CREATE TABLE unrelated(value TEXT)")
        with self.assertRaisesRegex(ValueError, "unrelated database"):
            self.build()

    def test_transaction_rolls_back_invalid_reachable_yield(self):
        self.build()
        before = self.output.read_bytes()
        file = self.root / "db\\Production.xml"
        file.write_text(file.read_text(encoding="utf-16").replace(
            'ProductionCount="2"', 'ProductionCount="0"'), encoding="utf-16")
        with self.assertRaises(sqlite3.IntegrityError):
            self.build()
        self.assertEqual(self.output.read_bytes(), before)

    def test_shorthand_categories_are_explicitly_unverified(self):
        file = self.root / "db\\Production.xml"
        file.write_text(file.read_text(encoding="utf-16").replace(
            "*/intermediate/*", "/intermediate/"), encoding="utf-16")
        self.build()
        with closing(sqlite3.connect(self.output)) as db:
            self.assertEqual(db.execute("SELECT match_status FROM recipe_ingredients "
                                        "WHERE category_expression='/intermediate/'").fetchone()[0],
                             "category_fragment_candidate_unverified")

    def test_localization_key_and_locale_membership(self):
        catalog = ClientCatalog(self.root)
        self.assertEqual(catalog.localize("_LT[xml.itemdb.50]"), "Soul Liberator Test")
        self.assertEqual(locale_status([{"locale": "korea usa"}]), "eligible")
        self.assertEqual(locale_status([{"locale": "korea"}]), "excluded")
        self.assertEqual(locale_status([{"__locale": "!korea"}]), "unresolved")
        self.write("local\\xml\\itemdb.english.txt", "1\tA\n1\tB\n", "utf-8-sig")
        with self.assertRaisesRegex(ValueError, "Duplicate localization"):
            ClientCatalog(self.root).localize("_LT[xml.itemdb.1]")

    def test_manual_sources_exclusions_restore_and_refresh(self):
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            auto_key = db.execute("SELECT source_key FROM effective_sources WHERE kind='shop'").fetchone()[0]
            db.execute("INSERT INTO manual_sources(item_id,kind,source_name,currency,price,"
                       "purchase_quantity,notes) VALUES (3,'shop','Confirmed vendor','gold',80,1,'test')")
            db.execute("DELETE FROM effective_sources WHERE source_key=?", (auto_key,))
            self.assertEqual(db.execute("SELECT count(*) FROM acquisition_sources").fetchone()[0], 5)
            self.assertEqual(db.execute("SELECT status FROM exclusion_status").fetchone()[0], "excluded")
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            self.assertEqual(db.execute("SELECT count(*) FROM effective_sources").fetchone()[0], 5)
            self.assertEqual(db.execute("SELECT price,notes FROM manual_sources").fetchone(), (80, "test"))
            self.assertEqual(db.execute("SELECT source_count FROM materials WHERE item_id=3")
                             .fetchone()[0], 2)
            db.execute("DELETE FROM source_exclusions WHERE source_key=?", (auto_key,))
            self.assertEqual(db.execute("SELECT count(*) FROM effective_sources").fetchone()[0], 6)
            db.execute("DELETE FROM effective_sources WHERE origin='manual'")
            self.assertEqual(db.execute("SELECT count(*) FROM manual_sources").fetchone()[0], 0)

    def test_changed_auto_source_requires_exclusion_review(self):
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            db.execute("DELETE FROM effective_sources WHERE kind='shop'")
        file = self.root / "db\\NPCShop\\NPCShop.xml"
        file.write_text(file.read_text(encoding="utf-16").replace('Price="100"', 'Price="90"'),
                        encoding="utf-16")
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            self.assertEqual(db.execute("SELECT status FROM exclusion_status").fetchone()[0],
                             "source_changed_review_needed")
            self.assertEqual(db.execute("SELECT price FROM effective_sources WHERE kind='shop'")
                             .fetchone()[0], 90)
            db.execute("DELETE FROM effective_sources WHERE kind='shop'")
            self.assertEqual(db.execute("SELECT status FROM exclusion_status").fetchone()[0], "excluded")

    def test_manual_source_invalid_values_are_rejected(self):
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            db.execute("PRAGMA foreign_keys=ON")
            for price, quantity in ((-1, 1), (1.5, 1), (1, 0), (1, 1.5)):
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("INSERT INTO manual_sources(item_id,kind,source_name,currency,price,"
                               "purchase_quantity) VALUES (3,'shop','Vendor','gold',?,?)",
                               (price, quantity))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO manual_sources(item_id,kind,source_name) "
                           "VALUES (999,'other','Unknown item')")

    def test_v1_upgrade_preserves_auction_house_values(self):
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            db.executescript("""
                DROP VIEW materials; DROP VIEW effective_sources; DROP VIEW exclusion_status;
                DROP TABLE source_exclusions; DROP TABLE source_signatures; DROP TABLE manual_sources;
                PRAGMA user_version=1;
                UPDATE auction_house_prices SET gold_per_unit=456 WHERE item_id=3;
            """)
        self.build()
        with closing(sqlite3.connect(self.output)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 4)
            self.assertEqual(db.execute("SELECT gold_per_unit FROM auction_house_prices WHERE item_id=3")
                             .fetchone()[0], 456)

    def test_v2_upgrade_and_persistent_user_facing_notes(self):
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            db.execute("DROP VIEW materials")
            db.execute("DROP TABLE item_notes")
            db.execute("PRAGMA user_version=2")
            db.execute("UPDATE auction_house_prices SET gold_per_unit=789 WHERE item_id=3")
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 4)
            self.assertEqual(db.execute("SELECT gold_per_unit FROM auction_house_prices WHERE item_id=3")
                             .fetchone()[0], 789)
            db.execute("""
                INSERT INTO item_notes(note_key,item_id,kind,status,title,message,evidence)
                VALUES ('manual-note',3,'naming','reported','Possible typo','Needs checking',
                        'User observation')
            """)
            self.assertEqual(db.execute("SELECT note_count FROM materials WHERE item_id=3")
                             .fetchone()[0], 1)
            db.execute("UPDATE item_notes SET message='Edited explanation',enabled=0")
        self.build()
        with closing(sqlite3.connect(self.output)) as db:
            self.assertEqual(db.execute("SELECT message,enabled FROM item_notes").fetchone(),
                             ("Edited explanation", 0))
            self.assertEqual(db.execute("SELECT note_count FROM materials WHERE item_id=3")
                             .fetchone()[0], 0)

    def test_seeded_note_refresh_preserves_edits_and_disabled_state(self):
        file = self.root / "db\\ItemDB.xml"
        file.write_text(file.read_text(encoding="utf-16").replace("</Items>", """
            <Mabi_Item ID="63385" Category="/material/leaf/plate/"
                Text_Name1="Melodic Metal Plate"/>
        </Items>"""), encoding="utf-16")
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            db.execute("UPDATE item_notes SET message='User clarification',enabled=0 "
                       "WHERE note_key='melodic-metal-plate-craft-label'")
        self.build()
        with closing(sqlite3.connect(self.output)) as db:
            self.assertEqual(db.execute("SELECT message,enabled FROM item_notes").fetchone(),
                             ("User clarification", 0))

    def test_refresh_preserves_desktop_tracking_workspace(self):
        self.build()
        with closing(sqlite3.connect(self.output)) as db, db:
            db.execute("CREATE TABLE planner_workspace(id INTEGER PRIMARY KEY,state_json TEXT NOT NULL)")
            db.execute("""INSERT INTO planner_workspace VALUES(1,'{"obolValue":600000,"plans":[]}')""")
            db.execute("CREATE TABLE planner_preferences(id INTEGER PRIMARY KEY,undo_key TEXT,redo_key TEXT)")
            db.execute("INSERT INTO planner_preferences VALUES(1,'Alt+Shift+Z','Ctrl+Shift+Z')")
        self.build()
        with closing(sqlite3.connect(self.output)) as db:
            self.assertEqual(db.execute("SELECT state_json FROM planner_workspace").fetchone()[0],
                             '{"obolValue":600000,"plans":[]}')
            self.assertEqual(db.execute("SELECT undo_key,redo_key FROM planner_preferences").fetchone(),
                             ("Alt+Shift+Z", "Ctrl+Shift+Z"))


class DeliveredCatalogTests(unittest.TestCase):
    def test_all_29_sl_items_and_complete_recursive_membership(self):
        expected = {1000059, 1010070, 1020004, 1040054, 1040055, 1050017, 1060011,
                    1070014, 1080048, 1090010, 1200043, 1210067, 1220018, 1230039,
                    1250026, 1260020, 1270029, 1280018, 1290021, 1400011, 1400012,
                    1420006, 1420007, 1430005, 1440006, 1460003, 1640003, 1640004, 1650001}
        self.assertTrue(DEFAULT_DATABASE.is_file(), "Material database deliverable missing")
        with closing(sqlite3.connect(DEFAULT_DATABASE)) as db:
            self.assertEqual({r[0] for r in db.execute("SELECT item_id FROM sl_items")}, expected)
            self.assertEqual(db.execute("SELECT count(*) FROM materials").fetchone()[0], 214)
            reachable = set(db.execute("""
                WITH RECURSIVE reachable(sl,item) AS (
                    SELECT item_id,item_id FROM sl_items
                    UNION
                    SELECT x.sl,c.item_id FROM reachable x
                    JOIN recipes r ON r.product_item_id=x.item
                    JOIN ingredient_candidates c ON c.recipe_key=r.recipe_key
                ) SELECT sl,item FROM reachable WHERE sl!=item
            """))
            self.assertEqual(reachable, set(db.execute(
                "SELECT sl_item_id,material_item_id FROM sl_materials")))
            self.assertEqual(db.execute("""
                SELECT count(*) FROM recipe_ingredients i WHERE NOT EXISTS(
                    SELECT 1 FROM ingredient_candidates c
                    WHERE c.recipe_key=i.recipe_key AND c.position=i.position)
            """).fetchone()[0], 0)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_staff_lyre_and_screenshot_provenance(self):
        with closing(sqlite3.connect(DEFAULT_DATABASE)) as db:
            self.assertEqual([r[0] for r in db.execute("""
                SELECT i.quantity FROM recipe_ingredients i JOIN recipes r USING(recipe_key)
                WHERE r.product_item_id=1230039 ORDER BY i.position
            """)], [9, 18, 15, 3, 3, 20, 48, 50])
            self.assertEqual([r[0] for r in db.execute("""
                SELECT i.quantity FROM recipe_ingredients i JOIN recipes r USING(recipe_key)
                WHERE r.product_item_id=1080048 ORDER BY i.position
            """)], [8, 15, 1, 1, 6, 3, 30, 50])
            self.assertEqual(db.execute("SELECT name FROM items WHERE item_id=63385").fetchone()[0],
                             "Melodic Metal Plate")
            self.assertEqual(db.execute("SELECT count(*) FROM recipes "
                                        "WHERE product_item_id=67209").fetchone()[0], 2)
            self.assertEqual(db.execute("""
                SELECT price,currency,currency_item_id,purchase_quantity,evidence
                FROM acquisition_sources WHERE source_key='leannan:5100334'
            """).fetchone(), (100, "item", 5300217, 1, "user_screenshot_2026-11-05"))
            self.assertEqual(db.execute("SELECT count(*) FROM acquisition_sources "
                                        "WHERE source_name='Leannan'").fetchone()[0], 30)

    def test_confirmed_plate_note_is_available_for_user_display(self):
        with closing(sqlite3.connect(DEFAULT_DATABASE)) as db:
            row = db.execute("""
                SELECT item_id,status,observed_label,correct_label,evidence,enabled
                FROM item_notes WHERE note_key='melodic-metal-plate-craft-label'
            """).fetchone()
            self.assertEqual(row[:4], (63385, "confirmed", "Melodic Metal Board", "Melodic Metal Plate"))
            self.assertIn("production.6649", row[4])
            self.assertEqual(row[5], 1)
            self.assertEqual(db.execute("SELECT note_count FROM materials WHERE item_id=63385")
                             .fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
