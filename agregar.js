// Filtros y agregaciones del panel de tiempos de tramitación, con la misma
// semántica que APP_JS de la v7 (legado/02_dashboard_tiempos_v7.py). Vive
// aparte de index.html para que prueba.js la corra con node.
//
// El modelo (datos.js, ver extraer.py) es por columnas: `exp` tiene una fila
// por expediente y las tablas etapaOcc, actOcc, expEtapa y expAct cuelgan de
// ella con `ini`: las filas del expediente i van de ini[i] a ini[i+1] - 1.
//
// Reglas que se equivocan en silencio (todas vienen de la v7):
//   - El filtro de atípicos afecta SOLO promedios y medianas, nunca conteos.
//   - «Expedientes ingresados» ignora el filtro de estado del sistema.
//   - La etapa seleccionada (clic en el gráfico) recorta todo el universo a
//     los expedientes que pasaron por ella, pero la tabla de etapas sigue
//     mostrando todas.
//   - Solo se promedian duraciones de lo finalizado (dias != null).

(function (global) {
  'use strict';

  // 'AAAA-MM-DD' -> días desde 1970-01-01, la unidad de exp.fi / exp.ft.
  function dia(texto) {
    return texto ? Math.floor(Date.parse(texto + 'T00:00:00Z') / 864e5) : null;
  }

  function fecha(d) {
    return d == null ? null : new Date(d * 864e5).toISOString().slice(0, 10);
  }

  // Percentil con interpolación lineal sobre un arreglo YA ORDENADO (v7).
  function percentil(ordenados, p) {
    if (!ordenados.length) return null;
    var idx = (p / 100) * (ordenados.length - 1);
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    return ordenados[lo] + (ordenados[hi] - ordenados[lo]) * (idx - lo);
  }

  function resumir(valores) {
    if (!valores.length) return { promedio: null, mediana: null, n: 0 };
    var s = 0;
    for (var i = 0; i < valores.length; i++) s += valores[i];
    var ord = valores.slice().sort(function (a, b) { return a - b; });
    return { promedio: s / valores.length, mediana: percentil(ord, 50), n: valores.length };
  }

  // Cuartiles para la caja, con el mismo percentil lineal. Bigotes de Tukey
  // (1,5 × rango intercuartil, igual que FACTOR_IQR de la metodología): llegan
  // al último valor observado dentro del límite; lo que queda fuera se lista.
  function caja(valores) {
    if (!valores.length) return null;
    var v = valores.slice().sort(function (a, b) { return a - b; });
    var q1 = percentil(v, 25), q3 = percentil(v, 75), rango = q3 - q1;
    var li = q1 - 1.5 * rango, ls = q3 + 1.5 * rango, inf = null, sup = null, fuera = [];
    for (var i = 0; i < v.length; i++) {
      if (v[i] < li || v[i] > ls) fuera.push(v[i]);
      else { if (inf === null) inf = v[i]; sup = v[i]; }
    }
    return { n: v.length, q1: q1, mediana: percentil(v, 50), q3: q3, min: v[0], max: v[v.length - 1],
             bigoteInf: inf, bigoteSup: sup, fuera: fuera };
  }

  // Histograma con ancho de clase «redondo» (1, 2, 5 × 10^k) para ~`clases`
  // clases hasta el percentil 99. Lo que pasa de ahí va a una última clase
  // abierta («más de X días»): con la cola larga de estos datos, un eje hasta
  // el máximo aplasta todo el resto contra el cero.
  function histograma(valores, clases) {
    if (!valores.length) return null;
    var v = valores.slice().sort(function (a, b) { return a - b; });
    var lo = Math.min(0, v[0]), p99 = percentil(v, 99), bruto = Math.max(1, (p99 - lo) / (clases || 30));
    var e = Math.pow(10, Math.floor(Math.log(bruto) / Math.LN10)), ancho = e;
    [1, 2, 5, 10].some(function (m) { ancho = m * e; return m * e >= bruto; });
    var n = Math.max(1, Math.ceil((p99 - lo) / ancho)), tope = lo + n * ancho;
    var cuenta = new Array(n).fill(0), cola = 0;
    for (var i = 0; i < v.length; i++) {
      if (v[i] >= tope) cola++;
      else cuenta[Math.floor((v[i] - lo) / ancho)]++;
    }
    return { desde: lo, ancho: ancho, cuenta: cuenta, cola: cola, tope: tope, n: v.length };
  }

  // Año de ingreso de cada expediente, calculado una vez.
  function anios(D) {
    if (!D._anio) D._anio = D.exp.fi.map(function (d) { return d == null ? null : new Date(d * 864e5).getUTCFullYear(); });
    return D._anio;
  }

  // Por año de INGRESO (cohorte): cuántos ingresaron, cuántos de esos ya
  // terminaron y la duración de los terminados. Los años recientes están
  // censurados: sus expedientes lentos siguen en proceso y no tienen duración,
  // así que su mediana sale más baja de lo que va a ser. `pctFin` lo dice.
  function porAnio(D, lista, sinAtipicos) {
    var A = anios(D), E = D.exp, m = {};
    for (var j = 0; j < lista.length; j++) {
      var i = lista[j], a = A[i];
      if (a == null) continue;
      var x = m[a] || (m[a] = { anio: a, ingresados: 0, finalizados: 0, dur: [] });
      x.ingresados++;
      if (E.fin[i]) {
        x.finalizados++;
        if (E.dur[i] != null && !(sinAtipicos && E.atip[i])) x.dur.push(E.dur[i]);
      }
    }
    return Object.keys(m).sort().map(function (k) {
      var x = m[k], r = resumir(x.dur);
      return { anio: x.anio, ingresados: x.ingresados, finalizados: x.finalizados,
               enProceso: x.ingresados - x.finalizados, pctFin: x.finalizados / x.ingresados,
               mediana: r.mediana, promedio: r.promedio, nDur: r.n };
    });
  }

  // f = { desde, hasta: 'AAAA-MM-DD'|null, estado: 'todos'|'enproceso'|'finalizado',
  //       sinAtipicos: bool, etapa: índice en D.etapas|null, region: índice en D.regiones|null }
  // Devuelve los índices de expediente que pasan.
  function expedientes(D, f, ignorarEstado) {
    var E = D.exp, n = E.fi.length, desde = dia(f.desde), hasta = dia(f.hasta), out = [];
    var ee = D.expEtapa;
    for (var i = 0; i < n; i++) {
      if (f.region != null && E.region[i] !== f.region) continue;
      var fi = E.fi[i];
      if (fi == null) { if (desde != null || hasta != null) continue; }
      else if ((desde != null && fi < desde) || (hasta != null && fi > hasta)) continue;
      if (!ignorarEstado) {
        if (f.estado === 'enproceso' && E.fin[i]) continue;
        if (f.estado === 'finalizado' && !E.fin[i]) continue;
      }
      if (f.etapa != null) {
        var paso = false;
        for (var k = ee.ini[i]; k < ee.ini[i + 1]; k++) if (ee.etapa[k] === f.etapa) { paso = true; break; }
        if (!paso) continue;
      }
      out.push(i);
    }
    return out;
  }

  // Duraciones, finalizados y en proceso por etapa (o por actividad).
  // occ: tabla de ocurrencias (duraciones); cruce: tabla expediente x etapa
  // (conteos). campo: 'etapa' | 'act'.
  function porGrupo(occ, cruce, campo, lista, sinAtipicos, largo) {
    var dur = [], fin = new Array(largo).fill(0), proc = new Array(largo).fill(0);
    var ocurr = [], visto = new Array(largo).fill(false);
    for (var g = 0; g < largo; g++) { dur.push([]); ocurr.push([]); }
    for (var j = 0; j < lista.length; j++) {
      var i = lista[j], k;
      for (k = occ.ini[i]; k < occ.ini[i + 1]; k++) {
        var gr = occ[campo][k];
        visto[gr] = true;
        if (occ.dias[k] == null) continue;
        if (sinAtipicos && occ.atip[k]) continue;
        dur[gr].push(occ.dias[k]);
      }
      for (k = cruce.ini[i]; k < cruce.ini[i + 1]; k++) {
        var c = cruce[campo][k];
        visto[c] = true;
        if (cruce.est[k] & 1) fin[c]++;
        if (cruce.est[k] & 2) proc[c]++;
        if (cruce.ocurr) ocurr[c].push(cruce.ocurr[k]);
      }
    }
    var filas = [];
    for (g = 0; g < largo; g++) {
      if (!visto[g]) continue;
      var r = resumir(dur[g]);
      filas.push({ indice: g, duracion: r.promedio, mediana: r.mediana, nObservaciones: r.n,
                   finalizados: fin[g], enProceso: proc[g],
                   recurrencia: ocurr[g].length ? resumir(ocurr[g]).promedio : null });
    }
    return filas;   // en el orden del proceso: los diccionarios ya vienen así
  }

  function calcular(D, f) {
    var sinEstado = expedientes(D, f, true);
    var lista = expedientes(D, f, false);
    var E = D.exp, fin = 0, durTotal = [];
    for (var j = 0; j < lista.length; j++) {
      var i = lista[j];
      if (!E.fin[i]) continue;
      fin++;
      // Atípicos: solo afecta la duración, no el conteo de finalizados.
      if (E.dur[i] != null && !(f.sinAtipicos && E.atip[i])) durTotal.push(E.dur[i]);
    }
    var total = resumir(durTotal);

    var etapas = porGrupo(D.etapaOcc, D.expEtapa, 'etapa', lista, f.sinAtipicos, D.etapas.length);
    etapas.forEach(function (r) {
      r.etapa = D.etapas[r.indice].nombre;
      r.postulacion = D.etapas[r.indice].postulacion;
    });
    var actividades = porGrupo(D.actOcc, D.expAct, 'act', lista, f.sinAtipicos, D.actividades.length);
    actividades.forEach(function (r) {
      var a = D.actividades[r.indice];
      r.actividad = a.nombre;
      r.etapa = a.etapa >= 0 ? D.etapas[a.etapa].nombre : 'Sin clasificar';
      r.postulacion = a.etapa >= 0 && D.etapas[a.etapa].postulacion;
      delete r.recurrencia;
    });

    return {
      expedientes: lista,
      kpi: { ingresados: sinEstado.length, finalizados: fin, enProceso: lista.length - fin,
             promedio: total.promedio, mediana: total.mediana, nDur: total.n },
      histograma: durTotal,            // duración total de los finalizados (respeta atípicos)
      boxplot: cajas(D, lista),        // por etapa, siempre CON atípicos (v7)
      etapas: etapas,
      actividades: actividades,
      anual: porAnio(D, lista, f.sinAtipicos),
    };
  }

  // Comparación regional: se calcula SIN el filtro de región, para que la
  // región elegida se destaque entre las demás en vez de quedar sola (como el
  // ranking de SUBSE). Los demás filtros sí se aplican.
  function porRegion(D, f) {
    var g = Object.assign({}, f, { region: null });
    var lista = expedientes(D, g, false), E = D.exp, m = D.regiones.map(function () {
      return { ingresados: 0, finalizados: 0, dur: [] };
    });
    for (var j = 0; j < lista.length; j++) {
      var i = lista[j], x = m[E.region[i]];
      x.ingresados++;
      if (E.fin[i]) {
        x.finalizados++;
        if (E.dur[i] != null && !(f.sinAtipicos && E.atip[i])) x.dur.push(E.dur[i]);
      }
    }
    return m.map(function (x, k) {
      var r = resumir(x.dur);
      return { indice: k, codigo: D.regiones[k].codigo, nombre: D.regiones[k].nombre,
               ingresados: x.ingresados, finalizados: x.finalizados, enProceso: x.ingresados - x.finalizados,
               mediana: r.mediana, promedio: r.promedio, nDur: r.n };
    }).filter(function (x) { return x.ingresados > 0; });
  }

  // Duraciones por etapa para el boxplot: finalizadas, con atípicos.
  function cajas(D, lista) {
    var occ = D.etapaOcc, out = D.etapas.map(function () { return []; });
    for (var j = 0; j < lista.length; j++) {
      var i = lista[j];
      for (var k = occ.ini[i]; k < occ.ini[i + 1]; k++) if (occ.dias[k] != null) out[occ.etapa[k]].push(occ.dias[k]);
    }
    return out;
  }

  var api = { dia: dia, fecha: fecha, percentil: percentil, resumir: resumir, caja: caja, histograma: histograma,
              expedientes: expedientes, calcular: calcular, porRegion: porRegion, porAnio: porAnio };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.AGG = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
