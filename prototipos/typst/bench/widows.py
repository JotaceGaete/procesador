# Viudas y huérfanas en el PDF (pdftotext -bbox): líneas del cuerpo de cada página; una línea
# empieza párrafo si tiene sangría (o sigue a un título/separador), y termina párrafo si no
# llega al margen derecho. Huérfana: la última línea de una página empieza un párrafo que sigue
# en la siguiente. Viuda: la primera línea de una página es la última de un párrafo que venía.
import re, sys, subprocess, collections
pdf = sys.argv[1]
html = subprocess.run(["pdftotext", "-bbox", pdf, "-"], capture_output=True, text=True).stdout
pages = html.split("<page ")[1:]
orphans = widows = checked = 0
examples = []
for n, pg in enumerate(pages, 1):
    words = [(float(a), float(b), float(c), t) for a, b, c, d, t in re.findall(r'xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<', pg)]
    body = [w for w in words if 50 < w[1] < 590]
    lines = collections.OrderedDict()
    for x0, y, x1, t in sorted(body, key=lambda w: (round(w[1]), w[0])):
        lines.setdefault(round(y), []).append((x0, x1, t))
    rows = [(min(a for a, _, _ in ws), max(b for _, b, _ in ws), " ".join(t for *_, t in ws)) for ws in lines.values()]
    if len(rows) < 6:
        continue
    left = min(r[0] for r in rows)
    right = max(r[1] for r in rows)
    checked += 1
    starts = lambda r: r[0] > left + 8                      # sangría
    ends = lambda r: r[1] < right - 12                      # línea corta
    first, last = rows[0], rows[-1]
    # Huérfana: última línea con sangría (empieza párrafo) y llena (sigue en la otra página).
    if starts(last) and not ends(last):
        orphans += 1; examples.append(f"p{n} huérfana: {last[2][:50]}")
    # Viuda: primera línea sin sangría y corta, seguida de una línea que empieza párrafo.
    if not starts(first) and ends(first) and len(rows) > 1 and (starts(rows[1]) or rows[1][2].startswith("*")):
        widows += 1; examples.append(f"p{n} viuda: {first[2][:50]}")
print(f"páginas revisadas {checked} · huérfanas {orphans} · viudas {widows}")
for e in examples[:8]: print("  ", e)
