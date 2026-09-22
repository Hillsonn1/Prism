// Charts drawn as inline SVG.

// Donut chart. slices: [[label, amount], ...]. Animates the sweep on first paint.
function donutChart({ slices, total, size = 190, thickness = 32, centerLabel = 'Total', onSliceClick = null }) {
  if (!slices.length || total === 0) return '';
  const cx = size / 2, cy = size / 2, R = size / 2 - 13, r = R - thickness;
  const style = `width:${size}px;height:${size}px;display:block;margin:0 auto`;
  const center = html`
    <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-size="${size > 200 ? 11 : 10}" fill="var(--muted)">${centerLabel}</text>
    <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="${size > 200 ? 17 : 13}" font-weight="700" fill="var(--text)">${fmt(total)}</text>`;

  if (slices.length === 1) {
    const color = categoryColor(slices[0][0]);
    const mid = (R + r) / 2, sw = R - r;
    const circ = +(2 * Math.PI * mid).toFixed(2);
    return html`<svg viewBox="0 0 ${size} ${size}" style="${style}">
      <circle cx="${cx}" cy="${cy}" r="${mid}" fill="none" stroke="${color}" stroke-width="${sw}" opacity=".9"
        stroke-dasharray="${circ}" stroke-dashoffset="${circ}" transform="rotate(-90 ${cx} ${cy})">
        <animate attributeName="stroke-dashoffset" from="${circ}" to="0" dur=".65s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".25,.1,.25,1"/>
      </circle>${center}</svg>`;
  }

  const id = `donut-${Math.random().toString(36).slice(2, 8)}`;
  const paths = slices.map(([cat, amt], i) => {
    const pct = amt / total;
    const title = `${cat}: ${fmt(amt)} (${Math.round(pct * 100)}%)`;
    return html`<path data-i="${i}" data-pct="${pct}" fill="${categoryColor(cat)}" opacity=".9"
      ${onSliceClick ? raw(`style="cursor:pointer" onclick="${onSliceClick}('${escAttr(cat)}')"`) : ''}><title>${title}</title></path>`;
  });

  requestAnimationFrame(() => {
    const svg = document.getElementById(id);
    if (!svg) return;
    const els = [...svg.querySelectorAll('path[data-pct]')];
    const t0 = performance.now(), dur = 700;
    function frame(now) {
      const rawT = Math.min((now - t0) / dur, 1);
      const progress = (1 - Math.pow(1 - rawT, 3)) * 2 * Math.PI;
      let start = -Math.PI / 2, cum = 0;
      for (const p of els) {
        const full = +p.dataset.pct * 2 * Math.PI;
        const drawn = Math.max(0, Math.min(full, progress - cum));
        cum += full;
        if (drawn < 0.0001) { p.setAttribute('d', ''); start += full; continue; }
        const end = start + drawn, large = drawn > Math.PI ? 1 : 0;
        const x1 = cx + R * Math.cos(start), y1 = cy + R * Math.sin(start);
        const x2 = cx + R * Math.cos(end), y2 = cy + R * Math.sin(end);
        const x3 = cx + r * Math.cos(end), y3 = cy + r * Math.sin(end);
        const x4 = cx + r * Math.cos(start), y4 = cy + r * Math.sin(start);
        p.setAttribute('d', `M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L${x3.toFixed(2)} ${y3.toFixed(2)} A${r} ${r} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`);
        start += full;
      }
      if (rawT < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });

  return html`<svg id="${id}" viewBox="0 0 ${size} ${size}" style="${style}">${paths}${center}</svg>`;
}

// Monthly bar chart for one merchant (used by the merchant history modal)
function monthlyBarChart(monthly, color) {
  const months = Object.keys(monthly).sort();
  if (!months.length) return '';
  const maxAmt = Math.max(...months.map(m => monthly[m]));
  const svgW = 500, svgH = 230, padL = 58, padR = 12, padT = 16, padB = 44;
  const cW = svgW - padL - padR, cH = svgH - padT - padB;
  const steps = 4;
  const grid = Array.from({ length: steps + 1 }, (_, i) => {
    const y = padT + (i / steps) * cH;
    return html`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${svgW - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
      <text x="${padL - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtShort(maxAmt * (1 - i / steps))}</text>`;
  });
  const axes = html`<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + cH}" stroke="var(--border-strong)" stroke-width="1.5"/>
    <line x1="${padL}" y1="${padT + cH}" x2="${svgW - padR}" y2="${padT + cH}" stroke="var(--border-strong)" stroke-width="1.5"/>`;
  const barW = cW / months.length, barPad = Math.max(barW * 0.25, 4);
  const bars = months.map((m, i) => {
    const [yr, mo] = m.split('-');
    const label = new Date(+yr, +mo - 1, 1).toLocaleString('default', { month: 'short' }) + " '" + String(yr).slice(2);
    const barH = Math.max((monthly[m] / maxAmt) * cH, 2);
    const x = padL + i * barW + barPad / 2, y = padT + cH - barH, w = barW - barPad, cxb = padL + i * barW + barW / 2;
    const bottom = (padT + cH).toFixed(1), delay = (i * 0.05).toFixed(2);
    return html`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" rx="3" opacity="0.9">
        <animate attributeName="height" from="0" to="${barH.toFixed(1)}" dur=".45s" begin="${delay}s" calcMode="spline" keyTimes="0;1" keySplines=".25,1,.5,1" fill="freeze"/>
        <animate attributeName="y" from="${bottom}" to="${y.toFixed(1)}" dur=".45s" begin="${delay}s" calcMode="spline" keyTimes="0;1" keySplines=".25,1,.5,1" fill="freeze"/>
      </rect>
      <text x="${cxb.toFixed(1)}" y="${(svgH - padB + 16).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${label}</text>`;
  });
  return html`<svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%;height:auto;display:block">${grid}${axes}${bars}</svg>`;
}
