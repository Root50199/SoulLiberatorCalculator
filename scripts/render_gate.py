"""Offline orthographic gate render from the read-only MRD PMG v3 mesh."""

import argparse
import json
from pathlib import Path
import struct

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
VERTEX = np.dtype([
    ("position", "<f4", 3), ("normal", "<f4", 3),
    ("bgra", "u1", 4), ("uv", "<f4", 2),
])


def decode_gate(data):
    if data[:6] != b"pmg\x00\x02\x01":
        raise ValueError("Expected PMG global version 2.1.")
    offset = struct.unpack_from("<I", data, 6)[0]
    groups = struct.unpack_from("<I", data, 138)[0]
    declared = struct.unpack_from("<I", data, 206)[0]
    if groups != 1 or offset != 142 + 68 + declared * 204:
        raise ValueError("Unexpected gate group table.")
    meshes = []
    while offset < len(data):
        magic, version, length = struct.unpack_from("<4s2sI", data, offset)
        if magic != b"pm!\x00" or version != b"\x03\x00" or length < 436:
            raise ValueError(f"Unexpected PMG v3 block at {offset}.")
        end = offset + length
        if end > len(data):
            raise ValueError("Truncated mesh block.")
        block = memoryview(data)[offset + 10:end]
        minor = np.frombuffer(block, "<f4", 16, 0).reshape(4, 4)
        major = np.frombuffer(block, "<f4", 16, 64).reshape(4, 4)
        if not np.array_equal(minor, np.eye(4)) or not np.array_equal(major, np.eye(4)):
            raise ValueError("Gate transform changed; verify placement before rendering.")
        part = struct.unpack_from("<I", block, 128)[0]
        face_count, triangles, strip_count, _, vertex_count, skins = struct.unpack_from("<6I", block, 180)
        sizes = struct.unpack_from("<4I", block, 240)
        if sizes != (face_count * 2, strip_count * 2, vertex_count * 36, 0) or skins:
            raise ValueError("Unexpected geometry sizes or skinned gate.")
        cursor = 260
        names = []
        for _ in range(8):
            size = struct.unpack_from("<I", block, cursor)[0]
            cursor += 4
            if cursor + size > len(block):
                raise ValueError("Truncated material name.")
            names.append(bytes(block[cursor:cursor + size]).decode("ascii"))
            cursor += size
        if struct.unpack_from("<I", block, cursor)[0] != 64:
            raise ValueError("Unexpected v3 bounds section.")
        cursor += 64
        if cursor + sum(sizes) != len(block) or face_count != triangles * 3:
            raise ValueError("Mesh sections do not cover the declared block exactly.")
        indices = np.frombuffer(block, "<u2", face_count, cursor).reshape(-1, 3).copy()
        cursor += sizes[0] + sizes[1]
        vertices = np.frombuffer(block, VERTEX, vertex_count, cursor).copy()
        if indices.max() >= vertex_count:
            raise ValueError("Triangle references a missing vertex.")
        for field in ("position", "normal", "uv"):
            if not np.isfinite(vertices[field]).all():
                raise ValueError(f"Non-finite {field}.")
        if not np.allclose(np.linalg.norm(vertices["normal"], axis=1), 1, atol=0.001):
            raise ValueError("Invalid vertex normals.")
        if names[7] not in {f"scene_prop_mrd_gate01_{i:02}" for i in range(1, 5)}:
            raise ValueError(f"Unexpected gate texture: {names[7]}")
        meshes.append((part, names[7], vertices, indices))
        offset = end
    if len(meshes) != declared or {mesh[0] for mesh in meshes} != set(range(6)):
        raise ValueError("Expected all six gate mesh parts exactly once.")
    return meshes


def render(meshes, textures, width=2048, direction=-1, supersample=2):
    solid = [mesh for mesh in meshes if mesh[0] != 5]
    points = np.concatenate([mesh[2]["position"] for mesh in solid])
    lower, upper = points.min(axis=0), points.max(axis=0)
    margin = 32 * supersample
    width *= supersample
    scale = (width - margin * 2) / (upper[0] - lower[0])
    height = int(np.ceil((upper[1] - lower[1]) * scale)) + margin * 2
    color = np.zeros((height, width, 4), dtype=np.uint8)
    depth = np.full((height, width), -np.inf, dtype=np.float32)
    light = np.array([-0.3, 0.6, direction * 0.75])
    light /= np.linalg.norm(light)
    for part, name, vertices, triangles in solid:
        texture = textures[name]
        p = vertices["position"]
        screen = np.column_stack((
            (p[:, 0] - lower[0]) * scale + margin,
            (upper[1] - p[:, 1]) * scale + margin,
        ))
        for triangle in triangles:
            xy = screen[triangle]
            x0, y0 = np.maximum(np.floor(xy.min(axis=0)).astype(int), 0)
            x1, y1 = np.minimum(np.ceil(xy.max(axis=0)).astype(int), [width - 1, height - 1])
            a, b, c = xy
            determinant = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
            if abs(determinant) < 1e-8 or x1 < x0 or y1 < y0:
                continue
            ys, xs = np.mgrid[y0:y1 + 1, x0:x1 + 1]
            xs, ys = xs + 0.5, ys + 0.5
            wa = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / determinant
            wb = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / determinant
            wc = 1 - wa - wb
            z = (wa * p[triangle[0], 2] + wb * p[triangle[1], 2] + wc * p[triangle[2], 2]) * direction
            target_depth = depth[y0:y1 + 1, x0:x1 + 1]
            visible = (wa >= -1e-6) & (wb >= -1e-6) & (wc >= -1e-6) & (z > target_depth)
            if not visible.any():
                continue
            weights = np.stack((wa[visible], wb[visible], wc[visible]), axis=1)
            uv = weights @ vertices["uv"][triangle]
            uv = np.clip(uv, 0, 1)
            tx = uv[:, 0] * (texture.shape[1] - 1)
            ty = uv[:, 1] * (texture.shape[0] - 1)
            ix, iy = tx.astype(int), ty.astype(int)
            jx = np.minimum(ix + 1, texture.shape[1] - 1)
            jy = np.minimum(iy + 1, texture.shape[0] - 1)
            fx, fy = (tx - ix)[:, None], (ty - iy)[:, None]
            sampled = (
                texture[iy, ix] * (1 - fx) * (1 - fy) +
                texture[iy, jx] * fx * (1 - fy) +
                texture[jy, ix] * (1 - fx) * fy +
                texture[jy, jx] * fx * fy
            )
            normals = weights @ vertices["normal"][triangle]
            normals /= np.maximum(np.linalg.norm(normals, axis=1)[:, None], 1e-6)
            illumination = 0.78 + 0.22 * np.maximum(normals @ light, 0)
            sampled[:, :3] *= illumination[:, None]
            target = color[y0:y1 + 1, x0:x1 + 1]
            target[visible] = np.clip(sampled, 0, 255).astype(np.uint8)
            target_depth[visible] = z[visible]
        print(f"Rendered solid part {part}: {len(triangles)} triangles ({name}).")
    image = Image.fromarray(color)
    return image.resize((width // supersample, height // supersample), Image.Resampling.LANCZOS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "src" / "assets" / "gate-front.png")
    parser.add_argument("--direction", type=int, choices=(-1, 1), default=-1)
    parser.add_argument("--width", type=int, default=2048)
    parser.add_argument("--supersample", type=int, default=2)
    args = parser.parse_args()
    if args.width < 128 or args.supersample not in (1, 2):
        parser.error("Width must be >=128; supersample must be 1 or 2.")
    config = json.loads((ROOT / "client-data.config.json").read_text())
    source = ROOT / config["dataRoot"] / "gfx" / "scene" / "dungeon" / "MRD" / "scene_prop_mrd_gate01.pmg"
    meshes = decode_gate(source.read_bytes())
    textures = {
        name: np.asarray(Image.open(source.parent / f"{name}.dds").convert("RGBA"), dtype=np.float32)
        for name in {mesh[1] for mesh in meshes}
    }
    image = render(meshes, textures, args.width, args.direction, args.supersample)
    image.save(args.output, optimize=True)
    print(f"Saved {args.output}: {image.size}, RGBA; effect slot 5 omitted.")


if __name__ == "__main__":
    main()
