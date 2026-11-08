import struct
import unittest

import numpy as np

from render_gate import VERTEX, decode_gate, render


def gate_fixture():
    header = bytearray(1434)
    header[:6] = b"pmg\x00\x02\x01"
    struct.pack_into("<I", header, 6, len(header))
    struct.pack_into("<I", header, 138, 1)
    struct.pack_into("<I", header, 206, 6)
    for part in range(6):
        block = bytearray(260)
        block[:64] = np.eye(4, dtype="<f4").tobytes()
        block[64:128] = block[:64]
        struct.pack_into("<I", block, 128, part)
        struct.pack_into("<6I", block, 180, 3, 1, 0, 0, 3, 0)
        struct.pack_into("<4I", block, 240, 6, 0, 108, 0)
        for name in ("bone01", f"gate_part_{part}", "bone01", "", "", "", "b1", "scene_prop_mrd_gate01_01"):
            encoded = name.encode("ascii")
            block.extend(struct.pack("<I", len(encoded)) + encoded)
        block.extend(struct.pack("<I", 64) + bytes(60))
        vertices = np.zeros(3, dtype=VERTEX)
        vertices["position"] = [(0, 0, 0), (2, 0, 0), (0, 2, 0)]
        vertices["normal"] = (0, 0, -1)
        vertices["uv"] = (0.5, 0.5)
        block.extend(struct.pack("<3H", 0, 1, 2) + vertices.tobytes())
        header.extend(b"pm!\x00\x03\x00" + struct.pack("<I", len(block) + 10) + block)
    return bytes(header)


class GateRenderTests(unittest.TestCase):
    def test_decodes_every_part_and_vertex_field(self):
        meshes = decode_gate(gate_fixture())
        self.assertEqual([mesh[0] for mesh in meshes], list(range(6)))
        for _, texture, vertices, triangles in meshes:
            self.assertEqual(texture, "scene_prop_mrd_gate01_01")
            np.testing.assert_array_equal(triangles, [[0, 1, 2]])
            np.testing.assert_array_equal(vertices["position"], [(0, 0, 0), (2, 0, 0), (0, 2, 0)])
            np.testing.assert_array_equal(vertices["uv"], np.full((3, 2), 0.5))

    def test_rejects_truncated_block(self):
        with self.assertRaisesRegex(ValueError, "Truncated mesh block"):
            decode_gate(gate_fixture()[:-1])

    def test_rejects_unknown_version(self):
        data = bytearray(gate_fixture())
        data[1438] = 2
        with self.assertRaisesRegex(ValueError, "Unexpected PMG v3"):
            decode_gate(data)

    def test_rejects_missing_part(self):
        data = bytearray(gate_fixture())
        struct.pack_into("<I", data, 1434 + 10 + 128, 5)
        with self.assertRaisesRegex(ValueError, "six gate mesh parts"):
            decode_gate(data)

    def test_portal_helper_never_changes_bounds_or_pixels(self):
        meshes = decode_gate(gate_fixture())
        meshes[5][2]["position"] *= 100
        textures = {"scene_prop_mrd_gate01_01": np.full((2, 2, 4), 255, dtype=np.float32)}
        image = render(meshes, textures, width=128, supersample=1)
        without_helper = render(meshes[:5], textures, width=128, supersample=1)
        np.testing.assert_array_equal(np.asarray(image), np.asarray(without_helper))
        self.assertEqual(image.mode, "RGBA")
        self.assertEqual(image.getpixel((90, 36))[3], 0)
        self.assertEqual(image.getpixel((36, 90))[3], 255)


if __name__ == "__main__":
    unittest.main()
