#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Generate the sidebar wordmark from Perfetto's bundled Roboto (fontTools required)."""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

root = Path(__file__).resolve().parent.parent
font = instantiateVariableFont(TTFont(root / 'third_party/src/perfetto/buildtools/typefaces/Roboto.woff2'), {'wght': 300, 'wdth': 100})
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
scale = 21.42 / font['head'].unitsPerEm
pen = SVGPathPen(glyphs)
x = 0
for char in 'Agent Profiler':
    glyph = glyphs[cmap[ord(char)]]
    glyph.draw(TransformPen(pen, (scale, 0, 0, -scale, x, 24.885)))
    x += glyph.width * scale
svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{x + 4:.3f}" height="36" viewBox="0 0 {x + 4:.3f} 36"><path fill="white" transform="translate(2 0)" d="{pen.getCommands()}"/></svg>'
out = root / 'third_party/overlays/perfetto/ui/src/core/embedder/agentprof_wordmark.ts'
out.write_text('// SPDX-License-Identifier: Apache-2.0\n// Generated from upstream Perfetto’s bundled Roboto by tools/generate-wordmark.py.\nexport const AGENTPROF_WORDMARK = ' + repr(svg) + ';\n')
