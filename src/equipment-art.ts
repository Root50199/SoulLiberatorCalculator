export const equipmentArtSource = 'https://www.nexon.com/mabinogi/news/28948/generation-27-the-garden-of-solace-update#soul-liberator-weapons'

// Original CDN paths retain provenance; local PNGs use the filename. Marionettes share one render.
const renders: Readonly<Record<number, string>> = {
  1000059: 'dpygpnqt/sl-sword-v2.png',
  1200043: 'yhhlyfrb/sl-greatsword.png',
  1010070: 'molj3wor/sl-hammer.png',
  1210067: 'gckhl225/sl-greathammer.png',
  1020004: 'ndulwypw/sl-axe.png',
  1220018: 'lsdgxphe/sl-greataxe.png',
  1400011: 'd14bz5u1/sl-shield-v2.png',
  1400012: 'hmufxbuf/sl-greatshield.png',
  1250026: 'tgfeufaj/sl-lance.png',
  1040054: 'r0gcwsog/sl-bow-v3.png',
  1420006: 'jh0lafo5/sl-arrow.png',
  1040055: 'tlre3xdh/sl-crossbow.png',
  1420007: 'jj2m5v3q/sl-bolt.png',
  1280018: '3drbktit/sl-ninja.png',
  1270029: 'rjxdqyi4/sl-guns.png',
  1290021: 'navfzxfs/sl-chain-blade.png',
  1260020: 'zm0pddcn/sl-knuckles.png',
  1070014: 'iihd25ja/sl-control-bars.png',
  1640003: 'f03pwso1/sl-puppets.png',
  1640004: 'f03pwso1/sl-puppets.png',
  1230039: 'ryogf1hf/sl-staff.png',
  1050017: 'yqjdrncl/sl-wand.png',
  1650001: 'g4dffbuc/sl-healing-wand.png',
  1430005: 'iaebv0ec/sl-grimoire.png',
  1060011: 'cfgkpjp2/sl-cylinder-v2.png',
  1440006: 'd53f2njf/sl-guard-cylinder-v2.png',
  1080048: '2benpkg2/sl-lyre.png',
  1090010: 'k2ubdcuc/sl-scythe.png',
  1460003: 'solmktpj/sl-orb.png',
}

export function equipmentArtUrl(id: number) {
  const render = renders[id]
  if (!render) throw new Error(`No official Soul Liberator render mapped for item ${id}.`)
  return `./equipment-art/${render.split('/')[1]}`
}
