/*
 * Visure — motore di estrazione dati
 * Legge il testo posizionato di un PDF (come lo fornisce pdf.js) e ricava:
 *   - dalle visure catastali (per immobile, storiche, per soggetto): fabbricati e terreni
 *   - dalle visure camerali (visure e fascicoli InfoCamere): dati della società
 * Poi compone i testi secondo i modelli dello studio, omettendo i dati assenti.
 * Funziona in Word (pannello) e in Node (collaudo). Nessun dato esce dal computer.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ utilità

  function pulisci(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function centro(it) { return it.x + it.w / 2; }

  var PARTICELLE = ["di", "del", "della", "dello", "dei", "degli", "delle", "da", "dal", "dalla", "dalle",
    "dai", "al", "alla", "allo", "ai", "agli", "alle", "e", "ed", "in", "su", "sul", "sulla", "per",
    "con", "tra", "fra", "a", "nel", "nella"];

  // "VIA DEL LAVORO" -> "Via del Lavoro"; "TRAVEDONA-MONATE" -> "Travedona-Monate"; "XXV APRILE" -> "XXV Aprile"
  function capitalizza(s) {
    s = pulisci(s);
    if (!s) return s;
    var parole = s.split(" ").map(accentoFinale);
    return parole.map(function (w, i) {
      var low = w.toLowerCase();
      if (i > 0 && PARTICELLE.indexOf(low) >= 0) return low;
      if (/^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(w) && w.length > 1) return w;   // numeri romani
      if (/\d/.test(w) && !/^\d+$/.test(w)) return w.toUpperCase();      // 12/A, S1
      if (/^S\.?N\.?C\.?$/.test(w)) return w;                              // senza numero civico
      // dell'industria -> dell'Industria ; sant'ambrogio -> Sant'Ambrogio
      var m = low.match(/^(d|l|dell|dall|all|nell|sull|sant|santa|sant)'(.+)$/);
      if (m && i > 0 && ["d", "l", "dell", "dall", "all", "nell", "sull"].indexOf(m[1]) >= 0) {
        return m[1] + "'" + maiuscolaParte(m[2]);
      }
      return low.split("-").map(function (p) {
        return p.split("'").map(maiuscolaParte).join("'");
      }).join("-");
    }).join(" ");
  }
  function maiuscolaParte(p) { return p ? p.charAt(0).toUpperCase() + p.slice(1) : p; }
  // nelle visure gli accenti finali sono scritti con l'apostrofo: LOCALITA' -> località, CANTU' -> cantù
  var ACCENTI = { a: "à", e: "è", i: "ì", o: "ò", u: "ù" };
  function accentoFinale(w) { return w.replace(/([aeiou])['`´]$/i, function (m, v) { return ACCENTI[v.toLowerCase()]; }); }

  function senzaZeri(s) { return String(s).replace(/^0+(?=\d)/, ""); }
  function euro(s) { var m = String(s || "").match(/Euro\s*([\d.]+,\d{2})/i); return m ? m[1] : ""; }

  // ------------------------------------------------------------------ righe di testo

  // pagine: [{ items: [{str, x, y, w}] }] -> righe ordinate dall'alto in basso, per pagina
  function costruisciRighe(pagine) {
    var righe = [];
    pagine.forEach(function (pg, np) {
      var its = pg.items.filter(function (i) { return pulisci(i.str); })
        .map(function (i) { return { str: pulisci(i.str), x: i.x, y: i.y, w: i.w, p: np }; })
        .sort(function (a, b) { return b.y - a.y || a.x - b.x; });
      var cur = null;
      its.forEach(function (it) {
        if (cur && Math.abs(cur.y - it.y) <= 1.5) cur.items.push(it);
        else { cur = { y: it.y, p: np, items: [it] }; righe.push(cur); }
      });
    });
    righe.forEach(function (r) {
      r.items.sort(function (a, b) { return a.x - b.x; });
      r.testo = r.items.map(function (i) { return i.str; }).join(" ");
    });
    return righe;
  }

  // ------------------------------------------------------------------ riconoscimento

  function riconosci(righe) {
    var t = righe.slice(0, 80).map(function (r) { return r.testo; }).join("\n");
    if (/Registro Imprese/i.test(t) && /(FASCICOLO|VISURA)\b/i.test(t) && /Codice fiscale/i.test(t + righe.slice(80, 200).map(function (r) { return r.testo; }).join("\n"))) return "camerale";
    if (/Servizi Catastali|Visura .*per (immobile|soggetto)|Catasto (dei )?(Fabbricati|Terreni)/i.test(t)) return "catasto";
    return null;
  }

  // ------------------------------------------------------------------ CATASTO

  var TOPONIMI = /^(VIA|VIALE|V\.LE|PIAZZA|P\.ZZA|PIAZZALE|PIAZZETTA|CORSO|C\.SO|LARGO|VICOLO|VICOLETTO|LOCALITA'?|LOC\.|FRAZIONE|FRAZ\.|STRADA|STRADELLA|CONTRADA|BORGO|BORGATA|REGIONE|CASCINA|CASCINE|PASSAGGIO|SALITA|DISCESA|RIONE|CORTE|ALZAIA|LUNGOLAGO|LUNGOMARE|LUNGOFIUME|RONCO|TRAVERSA|CALLE|CAMPO|SENTIERO|QUARTIERE|ZONA|CASALE|GALLERIA|VIOTTOLO|PARCO|VILLAGGIO|CHIASSO|RAMPA|SCALINATA|STRADONE|VIA VICINALE|STR\.|NUCLEO|PODERE|MASSERIA|BAITA|ALPE|CENTRO|PASSO)\b/;

  var QUALITA = {
    "INCOLT PROD": "incolto produttivo", "INCOLT STER": "incolto sterile", "SEMIN ARBOR": "seminativo arborato",
    "SEMIN IRRIG": "seminativo irriguo", "SEMIN IRR ARB": "seminativo irriguo arborato", "PRATO ARBOR": "prato arborato",
    "PRATO IRRIG": "prato irriguo", "PRATO IRR ARB": "prato irriguo arborato", "PASCOLO ARB": "pascolo arborato",
    "PASCOLO CESPUG": "pascolo cespugliato", "PASC CESPUG": "pascolo cespugliato", "ORTO IRRIG": "orto irriguo",
    "CAST FRUTTO": "castagneto da frutto", "FABB RURALE": "fabbricato rurale", "FU D ACCERT": "fabbricato urbano da accertare",
    "RELIT STRAD": "reliquato stradale", "BOSCO CEDUO": "bosco ceduo", "BOSCO ALTO": "bosco d'alto fusto",
    "BOSCO MISTO": "bosco misto", "ENTE URBANO": "ente urbano", "VIGNETO": "vigneto", "SEMINATIVO": "seminativo",
    "PRATO": "prato", "PASCOLO": "pascolo", "ULIVETO": "uliveto", "FRUTTETO": "frutteto", "ORTO": "orto",
    "AREA RURALE": "area rurale", "AREA FAB DM": "area fabbricato demolito", "STAGNO": "stagno", "CANNETO": "canneto",
    "VIGNETO ULIVETO": "vigneto uliveto", "SEMIN ARB": "seminativo arborato", "PRATO ARB": "prato arborato"
  };
  function qualita(s) { var k = pulisci(s).toUpperCase(); return QUALITA[k] || pulisci(s).toLowerCase(); }

  function trovaIntestazione(righe, i) {
    // raccoglie le voci d'intestazione della tabella attorno alla riga i (stessa pagina, entro 16 punti)
    var r0 = righe[i], its = [];
    for (var j = Math.max(0, i - 4); j < Math.min(righe.length, i + 5); j++) {
      if (righe[j].p === r0.p && Math.abs(righe[j].y - r0.y) <= 16) its = its.concat(righe[j].items);
    }
    var col = {}, trova = function (re) { return its.filter(function (it) { return re.test(it.str); }); };
    var one = function (re) { var a = trova(re); return a.length ? a[0] : null; };
    col.N = one(/^N\.$/);
    col.foglio = one(/^Foglio$/);
    col.part = one(/^(Particella|Numero)$/);
    col.sub = one(/^Sub$/);
    if (!col.foglio || !col.part) return null;
    var cat = one(/^Categoria$/);
    if (cat) {
      col.tipo = "F";
      col.sez = one(/^Sez(ione)?$/) || one(/^Urbana$/);
      col.zona = one(/^Zona Cens\.?$/) || one(/^Cens\.$/);
      col.micro = one(/^Micro Zona$/) || one(/^Micro$/);
      col.categoria = cat;
      col.classe = one(/^Classe$/);
      col.consistenza = one(/^Consistenza$/);
      col.superficie = one(/^Superficie$/);
      col.rendita = one(/^Rendita$/);
      var rif = col.rendita || col.superficie;
      col.infoX = rif ? rif.x + rif.w + 12 : 9999;
      var ult = one(/^Dati Ulteriori$/);
      col.ultX = ult ? ult.x - 6 : 9999;
    } else {
      col.tipo = "T";
      col.porz = one(/^Porz/);
      col.qualita = one(/^Qualit/);
      col.classeT = one(/^Classe$/);
      col.supTesta = one(/^Superficie/);
      col.haareca = one(/^ha are ca$/) || one(/^ha$/);
      col.deduz = one(/^Deduz/);
      col.dom = one(/^Dominicale$/);
      col.agr = one(/^Agrario$/);
      var rif2 = col.agr || col.dom;
      col.infoX = rif2 ? rif2.x + rif2.w + 12 : 9999;
    }
    col.yTop = Math.max.apply(null, its.map(function (it) { return it.y; }));
    col.yBottom = Math.min.apply(null, its.map(function (it) { return it.y; }));
    return col;
  }

  function vicino(it, cols) {
    var c = centro(it), best = null, d = Infinity;
    Object.keys(cols).forEach(function (k) {
      var h = cols[k];
      if (!h || typeof h !== "object" || h.x === undefined) return;
      var dd = Math.abs(centro(h) - c);
      if (dd < d) { d = dd; best = k; }
    });
    return best;
  }

  function separaIndirizzo(s) {
    // "VIA ANTONIO TAMBORINI n. 2 Piano S1" -> {via, civico, piano}
    s = pulisci(s);
    var piano = "", civico = "";
    var mp = s.match(/\s*\bPiano\s+(.+)$/i);
    if (mp) { piano = pulisci(mp[1]).replace(/\s*-\s*$/, ""); s = s.slice(0, mp.index); }
    var mc = s.match(/\s*\bn\.\s*(\S+)\s*$/i);
    if (mc) { civico = mc[1]; s = s.slice(0, mc.index); }
    // "n. SNC" resta come civico; "SNC" senza "n." resta attaccato alla via, come in visura
    return { via: pulisci(s), civico: civico, piano: piano };
  }

  function consistenza(s) {
    s = pulisci(s);
    var m;
    if ((m = s.match(/^([\d.,]+)\s*vani$/i))) return "vani " + m[1];
    if ((m = s.match(/^([\d.,]+)\s*m²$/i)) || (m = s.match(/^([\d.,]+)\s*mq\.?$/i))) return "mq. " + m[1];
    if ((m = s.match(/^([\d.,]+)\s*m³$/i)) || (m = s.match(/^([\d.,]+)\s*mc\.?$/i))) return "mc. " + m[1];
    return s;
  }

  function analizzaCatasto(righe) {
    var titolo = "", beni = [], avvisi = [];
    righe.slice(0, 15).forEach(function (r) {
      var m = r.testo.match(/Visura [^\n]*?per (immobile|soggetto)/i);
      if (m && !titolo) titolo = m[0].replace(/\s+Situazione.*$/, "");
    });
    var perImmobile = /per immobile/i.test(titolo);
    var storica = /storica/i.test(titolo);
    var ctx = { comune: "", codice: "", sezCens: "", catasto: "" };
    var col = null, attiva = false, primaTabellaFatta = false, ultimaT = null;

    // Dati della richiesta (visure per immobile)
    for (var k = 0; k < Math.min(righe.length, 40); k++) {
      var tx = righe[k].testo, mm;
      if ((mm = tx.match(/Comune di (.+?) \(Codice:?\s*([A-Z]\d{3})([A-Z])?\)/))) {
        ctx.comune = mm[1]; ctx.codice = mm[2]; ctx.sezCens = mm[3] || "";
      }
      if ((mm = tx.match(/Sezione(?: censuaria)?:?\s+([A-Z])\b/)) && /richiesta|Catasto Terreni/i.test(tx)) ctx.sezCens = mm[1];
      if (/Catasto Fabbricati/i.test(tx)) ctx.catasto = "F";
      if (/Catasto Terreni/i.test(tx)) ctx.catasto = "T";
    }

    for (var i = 0; i < righe.length; i++) {
      var r = righe[i], t = r.testo, m;
      if ((m = t.match(/^\d+\.\s+Immobili siti nel Comune di (.+?) \(Codice\s+([A-Z]\d{3})([A-Z])?\)(?:\s+Sezione\s+(.+?))?\s+Catasto dei (Fabbricati|Terreni)/))) {
        ctx = { comune: m[1], codice: m[2], sezCens: m[3] || "", nomeSez: m[4] || "", catasto: m[5] === "Terreni" ? "T" : "F" };
        attiva = false; col = null;
        continue;
      }
      if (r.items[0].x < 60 && /^(Intestazione degli immobili|INTESTATI|Situazione degli intestati|DATI DERIVANTI DA|L'intestazione alla data|Mappali Terreni Correlati|Immobile \d+:|Totale:)/.test(t)) {
        attiva = false;
        if (/^(Intestazione|INTESTATI|Situazione degli intestati|L'intestazione)/.test(t)) col = null;
        continue;
      }
      if (/^Situazione dell'unità immobiliare|^Situazione degli intestati relativa|^Situazione dell'immobile/i.test(t) && perImmobile) {
        // in una visura storica le situazioni successive alla prima sono il passato: si ignorano
        if (primaTabellaFatta) { attiva = false; col = null; }
      }
      if (r.items.some(function (it) { return it.str === "Foglio"; })) {
        var c = trovaIntestazione(righe, i);
        if (c) {
          if (perImmobile && primaTabellaFatta) { attiva = false; col = null; continue; }
          if (c.tipo === "T") {
            // nelle pagine di continuazione manca la riga "ha are ca / Dominicale Agrario": si riusa la precedente
            if (ultimaT) ["haareca", "dom", "agr"].forEach(function (k) { if (!c[k] && ultimaT[k]) c[k] = ultimaT[k]; });
            if (c.agr || c.dom) { var rf = c.agr || c.dom; c.infoX = rf.x + rf.w + 12; }
            ultimaT = c;
          }
          col = c; attiva = true;
          if (!ctx.catasto) ctx.catasto = c.tipo;
        }
        continue;
      }
      if (!attiva || !col) continue;
      // riga di dati: numero d'ordine nella colonna N e valori sotto Foglio e Particella
      var nIt = r.items[0];
      if (!nIt || !/^\d+$/.test(nIt.str) || nIt.x > (col.foglio.x - 5)) continue;
      if (r.y >= col.yBottom - 1) continue;
      var bene = col.tipo === "F" ? rigaFabbricato(righe, i, col, ctx) : rigaTerreno(righe, i, col, ctx);
      if (!bene || !bene.campi.foglio || !bene.campi.particella) continue;
      if (perImmobile) {
        if (col.tipo === "F") bene.campi = Object.assign(bene.campi, indirizzoStorica(righe, i));
        beni.push(bene); primaTabellaFatta = true; attiva = false; col = null;
        continue;
      }
      beni.push(bene);
    }
    if (!beni.length) avvisi.push("Nessun immobile riconosciuto in questa visura.");
    return { tipo: "catasto", titolo: titolo || "Visura catastale", storica: storica, beni: beni, avvisi: avvisi };
  }

  // valori di una riga: elementi della stessa pagina vicini in verticale (le celle sono centrate sulla riga)
  function elementiRiga(righe, i, col, sopra, sotto) {
    var r = righe[i], its = [];
    for (var j = Math.max(0, i - 8); j < Math.min(righe.length, i + 9); j++) {
      var rr = righe[j];
      if (rr.p !== r.p) continue;
      if (rr.y > r.y + sopra || rr.y < r.y - sotto) continue;
      its = its.concat(rr.items);
    }
    return its;
  }

  function distanzaRighe(righe, i, col) {
    // spazio libero sopra e sotto fino alle righe di dati vicine (stessa tabella e pagina)
    var r = righe[i], su = 14, giu = 14;
    for (var j = i - 1; j >= 0 && righe[j].p === r.p; j--) {
      var a = righe[j].items[0];
      if (righe[j].y >= col.yBottom - 1) break;
      if (a && /^\d+$/.test(a.str) && a.x < col.foglio.x - 5) { su = Math.min(su, (righe[j].y - r.y) / 2); break; }
    }
    for (var k = i + 1; k < righe.length && righe[k].p === r.p; k++) {
      var b = righe[k].items[0];
      if (b && /^\d+$/.test(b.str) && b.x < col.foglio.x - 5) { giu = Math.min(giu, (r.y - righe[k].y) / 2); break; }
    }
    return { su: su, giu: giu };
  }

  function rigaFabbricato(righe, i, col, ctx) {
    var r = righe[i], d = distanzaRighe(righe, i, col);
    var colonne = {
      sez: col.sez, foglio: col.foglio, part: col.part, sub: col.sub, zona: col.zona, micro: col.micro,
      categoria: col.categoria, classe: col.classe, consistenza: col.consistenza,
      superficie: col.superficie, rendita: col.rendita
    };
    var cel = {};
    // valori principali sulla riga stessa
    r.items.slice(1).forEach(function (it) {
      if (it.x >= col.infoX) return;
      var k = vicino(it, colonne);
      if (k) cel[k] = cel[k] ? cel[k] + " " + it.str : it.str;
    });
    // superficie e rendita possono stare una riga sopra o sotto
    var vicini = elementiRiga(righe, i, col, d.su, d.giu).filter(function (it) { return it.x < col.infoX; });
    var sup = "", ren = "";
    vicini.forEach(function (it) {
      var k = vicino(it, colonne);
      var mS = it.str.match(/Totale:\s*([\d.,]+)\s*m²/);
      if (k === "superficie" || mS) { if (mS && !sup) sup = mS[1]; }
      if (/^Euro\s/.test(it.str) && !ren) ren = euro(it.str);
    });
    if (!sup) {
      // "Totale: 141" + "m² ..." su due righe
      var piena = vicini.filter(function (it) { return vicino(it, colonne) === "superficie"; })
        .sort(function (a, b) { return b.y - a.y; }).map(function (it) { return it.str; }).join(" ");
      var ms = piena.match(/Totale:\s*([\d.,]+)/);
      if (ms) sup = ms[1];
    }
    var categoria = pulisci(cel.categoria);
    var campi = {
      comune: ctx.comune, codicecomune: ctx.codice,
      sezioneurbana: pulisci(cel.sez), foglio: pulisci(cel.foglio), particella: pulisci(cel.part),
      subalterno: pulisci(cel.sub), zonacensuaria: pulisci(cel.zona), microzona: pulisci(cel.micro),
      categoria: categoria, classe: pulisci(cel.classe),
      consistenza: cel.consistenza ? consistenza(cel.consistenza) : "",
      superficiecatastale: sup, rendita: ren,
      indirizzo: "", numerocivico: "", piano: ""
    };
    // indirizzo nella colonna "Altre informazioni", sopra la riga (visure per soggetto)
    var ind = indirizzoSopra(righe, i, col);
    if (ind) {
      var s = separaIndirizzo(ind);
      campi.indirizzo = s.via; campi.numerocivico = s.civico; campi.piano = s.piano;
    }
    return { catasto: "F", campi: campi };
  }

  function indirizzoSopra(righe, i, col) {
    var r = righe[i];
    // limite superiore: riga di dati precedente o intestazione della tabella
    var limite = col.yBottom;
    for (var j = i - 1; j >= 0 && righe[j].p === r.p; j--) {
      var a = righe[j].items[0];
      if (righe[j].y >= col.yBottom - 1) break;
      if (a && /^\d+$/.test(a.str) && a.x < col.foglio.x - 5) { limite = righe[j].y; break; }
    }
    var info = [];
    for (var k = 0; k < righe.length; k++) {
      var rr = righe[k];
      if (rr.p !== r.p || rr.y >= limite - 0.5 || rr.y < r.y - 0.5) continue;
      rr.items.forEach(function (it) { if (it.x >= col.infoX && it.x < col.ultX) info.push(it); });
    }
    info.sort(function (a, b) { return b.y - a.y; });
    for (var n = 0; n < info.length; n++) {
      if (!TOPONIMI.test(info[n].str)) continue;
      var testo = info[n].str, y = info[n].y;
      for (var q = n + 1; q < info.length; q++) {
        var pianoAperto = /\bPiano\b.*-\s*$/.test(testo);       // "Piano S1 -" che continua sotto con "T-1"
        if (/\bPiano\b/.test(testo) && !pianoAperto) break;
        if (y - info[q].y > 10) break;
        if (/^(n\.\s|Piano\s|Scala\s|Interno\s)/.test(info[q].str) ||
            (pianoAperto && /^[A-Z0-9][A-Z0-9-]{0,4}(\s*-\s*[A-Z0-9][A-Z0-9-]{0,4})*\s*-?$/.test(info[q].str))) {
          testo += " " + info[q].str; y = info[q].y;
        }
        else break;
      }
      return testo;
    }
    return "";
  }

  function indirizzoStorica(righe, i) {
    for (var j = i + 1; j < Math.min(righe.length, i + 12); j++) {
      var it = righe[j].items;
      if (it[0] && it[0].str === "Indirizzo" && it[1]) {
        var s = separaIndirizzo(it.slice(1).map(function (x) { return x.str; }).join(" "));
        return { indirizzo: s.via, numerocivico: s.civico, piano: s.piano };
      }
      if (it[0] && /^Situazione|^Mappali|^Notifica/.test(it[0].str) && j > i + 1 && it[0].str !== "Notifica") break;
    }
    return {};
  }

  function numeroIt(s) { return parseFloat(String(s).replace(/\./g, "").replace(",", ".")) || 0; }
  function formatoIt(n) {
    var p = n.toFixed(2).split(".");
    return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + p[1];
  }
  function dueCifre(n) { return ("0" + n).slice(-2); }

  function rigaTerreno(righe, i, col, ctx) {
    var r = righe[i], d = distanzaRighe(righe, i, col);
    var supL = col.haareca ? col.haareca.x - 14 : (col.supTesta ? col.supTesta.x - 4 : 0);
    var supR = col.haareca ? col.haareca.x + col.haareca.w + 14 : (col.supTesta ? col.supTesta.x + col.supTesta.w + 4 : 0);
    var porzR = col.porz ? col.porz.x + col.porz.w + 4 : (col.sub ? col.sub.x + col.sub.w + 4 : col.part.x + col.part.w + 4);
    var porzL = col.porz ? col.porz.x - 6 : porzR;
    var foglio = "", part = "", sub = "";
    r.items.slice(1).forEach(function (it) {
      if (it.x >= col.infoX) return;
      var c = centro(it);
      if (c < (col.foglio.x + col.foglio.w + col.part.x) / 2) { foglio = it.str; return; }
      if (col.sub && c < (col.part.x + col.part.w + col.sub.x) / 2) { part = it.str; return; }
      if (!col.sub && c < porzL) { part = it.str; return; }
      if (col.sub && c < porzL) { sub = it.str; return; }
    });

    // la riga può essere divisa in porzioni (AA, AB...) scritte sopra e sotto la riga principale
    var banda = elementiRiga(righe, i, col, d.su, d.giu).filter(function (it) { return it.x < col.infoX; });
    var sotto = {};
    banda.forEach(function (it) {
      var k = Math.round(it.y * 2) / 2, trovato = null;
      Object.keys(sotto).forEach(function (y) { if (Math.abs(+y - it.y) <= 1.5) trovato = y; });
      (sotto[trovato || k] = sotto[trovato || k] || []).push(it);
    });
    var linee = Object.keys(sotto).map(function (y) { return { y: +y, items: sotto[y].sort(function (a, b) { return a.x - b.x; }) }; })
      .sort(function (a, b) { return b.y - a.y; });
    var conPorzione = linee.filter(function (l) {
      return l.items.some(function (it) { var c = centro(it); return c >= porzL && c < porzR && /^[A-Z]{1,2}$/.test(it.str); });
    });

    // limite sinistro della colonna Classe (intestazione separata o "Qualità Classe" in un solo elemento)
    var classeMinX = col.classeT ? col.classeT.x - 10 :
      (col.qualita && /Classe/.test(col.qualita.str) ? col.qualita.x + col.qualita.w * 0.55 : supL);

    // legge una parte: gli elementi possono stare su più linee (es. "SEMIN 3" sopra, "ARBOR" sotto la riga)
    function leggiParte(items) {
      var parte = { porz: "", qual: [], classe: "", sup: [], euro: [] };
      var perLinea = {};
      items.forEach(function (it) {
        var k = null;
        Object.keys(perLinea).forEach(function (y) { if (Math.abs(+y - it.y) <= 1.5) k = y; });
        k = k || String(it.y);
        (perLinea[k] = perLinea[k] || []).push(it);
      });
      Object.keys(perLinea).sort(function (a, b) { return +b - +a; }).forEach(function (y) {
        var inQual = 0;
        perLinea[y].sort(function (a, b) { return a.x - b.x; }).forEach(function (it) {
          var c = centro(it), str = pulisci(it.str);
          if (!str) return;
          if (/^Euro\s/.test(str)) { parte.euro.push(it); return; }
          if (/^(Lire|L\.)\s/.test(str)) return;
          if (c >= porzL && c < porzR) { if (str !== "-") parte.porz = str; return; }
          if (c < porzL) return;
          if (it.x >= supL && it.x + it.w <= supR && /^\d+(\s+\d+)*$/.test(str)) {
            parte.sup = parte.sup.concat(str.split(/\s+/)); return;
          }
          if (it.x + it.w < supL) {
            if (/^(\d{1,2}|U)$/.test(str) && (inQual > 0 || it.x >= classeMinX)) parte.classe = str;
            else parte.qual.push(str);
            inQual++;
          }
        });
      });
      return parte;
    }

    var parti;
    if (conPorzione.length) parti = conPorzione.map(function (l) { return leggiParte(l.items); });
    else parti = [leggiParte(banda)];

    var totCa = 0, haSup = false, dom = 0, agr = 0, haDom = false, haAgr = false, qualita2 = [], classi = [];
    parti.forEach(function (pt) {
      if (pt.sup.length) {
        haSup = true;
        var v = pt.sup.map(function (x) { return parseInt(x, 10); });
        if (v.length === 3) totCa += v[0] * 10000 + v[1] * 100 + v[2];
        else if (v.length === 2) totCa += v[0] * 100 + v[1];
        else totCa += v[0];
      }
      var eu = pt.euro.slice().sort(function (a, b) { return a.x - b.x; });
      if (col.dom && col.agr && eu.length === 1) {
        var c = centro(eu[0]);
        if (Math.abs(c - centro(col.dom)) <= Math.abs(c - centro(col.agr))) { dom += numeroIt(euro(eu[0].str)); haDom = true; }
        else { agr += numeroIt(euro(eu[0].str)); haAgr = true; }
      } else {
        if (eu[0]) { dom += numeroIt(euro(eu[0].str)); haDom = true; }
        if (eu[1]) { agr += numeroIt(euro(eu[1].str)); haAgr = true; }
      }
      var q = pt.qual.join(" ");
      if (q) { var qq = qualita(q); if (qualita2.indexOf(qq) < 0) qualita2.push(qq); }
      if (pt.classe) classi.push(senzaZeri(pt.classe));
    });
    var porzioni = parti.map(function (pt) { return pt.porz; }).filter(Boolean);
    var bene = {
      catasto: "T",
      campi: {
        comune: ctx.comune, codicecomune: ctx.codice, codicesezionecensuaria: ctx.sezCens || "",
        foglio: pulisci(foglio), particella: pulisci(part), subalterno: pulisci(sub), porzione: porzioni.join(", "),
        destinazione: qualita2.join(" e "), classe: classi.join(" e "),
        ettari: haSup ? String(Math.floor(totCa / 10000)) : "",
        are: haSup ? dueCifre(Math.floor(totCa / 100) % 100) : "",
        centiare: haSup ? dueCifre(totCa % 100) : "",
        redditodominicale: haDom ? formatoIt(dom) : "", redditoagrario: haAgr ? formatoIt(agr) : ""
      }
    };
    if (porzioni.length > 1) {
      bene.avviso = "Particella divisa in porzioni " + porzioni.join(", ") + ": superficie e redditi sono sommati, qualità e classi elencate. Da verificare.";
    }
    return bene;
  }

  // ------------------------------------------------------------------ CAMERALE

  // numero dei soci nel riquadro iniziale: "Soci e titolari di diritti su / azioni e quote  1"
  // (il numero può stare sulla stessa riga dell'etichetta o su quella successiva)
  function numeroSoci(righe) {
    for (var i = 0; i < righe.length; i++) {
      var et = null;
      righe[i].items.forEach(function (it) { if (!et && /^Soci e titolari di diritti su\b/.test(pulisci(it.str))) et = it; });
      if (!et || /^\s*\d+\s+Soci/.test(righe[i].testo)) continue;
      for (var j = i; j < Math.min(righe.length, i + 3); j++) {
        if (righe[j].p !== righe[i].p) break;
        var num = null;
        righe[j].items.forEach(function (it) {
          var t = pulisci(it.str);
          var m = t.match(/(?:^|azioni e quote\s+)(\d{1,6})$/);
          if (!num && m && it.x >= et.x - 2) num = parseInt(m[1], 10);
          var m2 = t.match(/^Soci e titolari di diritti su\s+(\d{1,6})$/);
          if (!num && m2) num = parseInt(m2[1], 10);
        });
        if (num !== null) return num;
      }
      return null;
    }
    return null;
  }

  function socioUnicoInCarica(righe) {
    for (var i = 0; i < righe.length; i++) {
      if (!/^\s*\d+\s+Titolari di altre cariche o qualifiche\s*$/.test(righe[i].testo)) continue;
      for (var j = i + 1; j < Math.min(righe.length, i + 60); j++) {
        var t = righe[j].testo;
        if (/^\s*\d+\s+[A-Z][a-z]/.test(t)) break;                // paragrafo successivo
        if (/^\s*Socio Unico\b/.test(t)) return true;
      }
    }
    return false;
  }

  // direzione e coordinamento (art. 2497-bis c.c.).
  // 1) paragrafo del Registro Imprese "Società o enti che esercitano attività di direzione e coordinamento";
  // 2) informazioni da statuto "gruppi societari ... DA PARTE DI X";
  // 3) solo in mancanza, i dati dell'ultimo bilancio (segnalati come da verificare).
  function direzioneCoordinamento(righe) {
    var L = righe.map(function (r) { return pulisci(r.testo); });
    var NUM_PAR = /^\d{1,2}\s+[A-Z][a-z']/;
    for (var i = 0; i < L.length; i++) {
      if (!/^\d{1,2}\s+Società o enti che esercitano attività di direzione/.test(L[i]) || /\.{3}/.test(L[i])) continue;
      for (var j = i + 1; j < Math.min(L.length, i + 45); j++) {
        if (NUM_PAR.test(L[j])) break;
        if (/cessazione|fine controllo/i.test(L[j])) continue;
        var m = L[j].match(/^controllante\s+(.+)$/i) ||
          L[j].match(/^(.+?)\s+(?:\d{11}|[A-Z0-9]{16})\s+inizio controllo\b/i);
        if (m) return { nome: pulisci(m[1].replace(/^"|"$/g, "")), fonte: "registro" };
      }
    }
    var tutto = L.join("\n");
    var ms = tutto.match(/gruppi societari\s+SOCIETA'?\s+SOTTOPOSTA AD ALTRUI ATTIVITA'?\s+DI DIREZIONE E COORDINAMENTO DA PARTE DI\s*\n?\s*"?([^"\n]+)"?/i);
    if (ms) return { nome: pulisci(ms[1]), fonte: "registro" };
    for (var k = 0; k < L.length; k++) {
      if (!/^Società sottoposta ad altrui attività di direzione e/i.test(L[k])) continue;
      var blocco = L.slice(k, k + 3).join(" ");
      if (!/coordinamento\s+si\b|\bsi\s+coordinamento\b|direzione e\s+si\b/i.test(blocco)) return null;
      for (var q = k + 1; q < Math.min(L.length, k + 6); q++) {
        var md = L[q].match(/^Denominazione della società o ente che esercita l'attività di\s*(.*)$/i);
        if (!md) continue;
        var nome = md[1];
        var seg = (L[q + 1] || "").match(/^direzione e coordinamento\s*(.*)$/i);
        if (seg) nome = pulisci(nome + " " + seg[1]);
        if (nome) return { nome: pulisci(nome), fonte: "bilancio" };
      }
      return null;
    }
    return null;
  }

  function analizzaCamerale(righe) {
    var L = righe.map(function (r) { return r.testo; });
    var tutto = L.join("\n");
    var avvisi = [];
    var campi = {};

    // ragione sociale
    var den = null;
    for (var i = 0; i < L.length; i++) {
      var m = L[i].match(/Denominazione:\s*(.+)$/);
      if (m) {
        den = m[1];
        // eventuale seguito su riga successiva (stessa colonna, senza "etichetta:")
        var nx = righe[i + 1];
        if (nx && !/:/.test(nx.testo) && nx.items[0] && Math.abs(nx.items[0].x - righe[i].items[righe[i].items.length - 1].x) < 4 &&
            /[A-Z]/.test(nx.testo) && nx.testo === nx.testo.toUpperCase() && nx.testo.length < 60) den += " " + nx.testo;
        break;
      }
    }
    if (!den) {
      for (var j = 0; j < L.length; j++) {
        if (/^(FASCICOLO|VISURA)\b.*(SOCIETA|IMPRESA)/i.test(L[j]) && L[j + 1]) { den = L[j + 1].replace(/\s+DATI ANAGRAFICI.*$/, ""); break; }
      }
    }
    campi.ragione_sociale = pulisci(den);

    // tipo di società
    var titolo = (tutto.match(/(FASCICOLO|VISURA)[^\n]*SOCIETA'? DI (CAPITALE|PERSONE)/i) || [])[0] || "";
    var forma = pulisci((tutto.match(/Forma giuridica\s+([^\n]+)/i) || [])[1] || "");
    var capitali = /DI CAPITALE/i.test(titolo) || /(per azioni|responsabilita' limitata|responsabilità limitata|accomandita per azioni|cooperativa|consortile)/i.test(forma);
    var persone = /DI PERSONE/i.test(titolo) || /(nome collettivo|accomandita semplice|societa' semplice|società semplice)/i.test(forma);
    campi._tipo = capitali ? "capitali" : (persone ? "persone" : "");

    // sede (preferisce il paragrafo "1 Sede", a colonna singola)
    var iSede = -1;
    for (var s = 0; s < L.length; s++) { if (/^\s*1\s+Sede\s*$/.test(L[s])) { iSede = s; break; } }
    var cercaDa = iSede >= 0 ? iSede : 0, sedeTesto = "";
    for (var a = cercaDa; a < L.length; a++) {
      var ms = L[a].match(/Indirizzo Sede legale\s+(.+)$/);
      if (ms) {
        sedeTesto = ms[1];
        for (var b = a + 1; b < Math.min(L.length, a + 4) && !/CAP\s*\d{5}/.test(sedeTesto); b++) sedeTesto += " " + L[b];
        break;
      }
    }
    var mSede = sedeTesto.match(/^(.+?)\s*\(([A-Z]{2})\)\s*(.*?)\s*(?:CAP\s*(\d{5}))?/);
    mSede = sedeTesto.match(/^(.+?)\s*\(([A-Z]{2})\)\s*(.*?)(?:\s*CAP\s*\d{5}.*)?$/);
    if (mSede) {
      campi.comune_sede = mSede[1];
      campi.provincia_sede = mSede[2];
      var via = pulisci(mSede[3]), civ = "";
      var mc = via.match(/^(.*?)\s+((?:\d+[A-Z]?(?:\/\s?[A-Z0-9]+)?)|SNC|S\.N\.C\.|KM\s*[\d,.]+)$/i);
      if (mc && !/^S\.?N\.?C\.?$/i.test(mc[2])) { via = mc[1]; civ = mc[2]; }   // "SNC" resta nella via, come in visura
      campi.indirizzo_sede = via; campi.civico_sede = civ;
    } else avvisi.push("Sede non trovata.");

    // capitale
    var mCap = tutto.match(/Capitale sociale in Euro[\s\S]{0,40}?Deliberato:\s*([\d.]+,\d{2})[\s\S]{0,40}?Sottoscritto:\s*([\d.]+,\d{2})[\s\S]{0,40}?Versato:\s*([\d.]+,\d{2})/i);
    if (mCap && campi._tipo !== "persone") {
      campi.capitale_sociale = mCap[2];
      campi._versato = mCap[3];
    } else {
      var mCap2 = tutto.match(/Capitale sociale\s+sottoscritto\s+([\d.]+,\d{2})/i);
      if (mCap2 && campi._tipo !== "persone") campi.capitale_sociale = mCap2[1];
    }

    // registro imprese, codice fiscale, REA
    var mReg = tutto.match(/del Registro delle Imprese di\s+([A-Z][A-Z' \-]+?)\s*(?:\n|$)/);
    campi.registro_imprese = mReg ? pulisci(mReg[1]) : "";
    var mCf = tutto.match(/Codice fiscale e numero d.\s?iscrizione:\s*([A-Z0-9]{11,16})/i) ||
      tutto.match(/Codice fiscale e n\.iscr\. al\s*(?:\n\s*Registro Imprese)?\s*([A-Z0-9]{11,16})/i) ||
      tutto.match(/Codice Fiscale\s+([0-9]{11}|[A-Z0-9]{16})/);
    campi.codice_fiscale = mCf ? mCf[1] : "";
    var mRea = tutto.match(/Numero REA\s+([A-Z]{2})\s*-\s*(\d+)/) ||
      tutto.match(/Numero repertorio economico\s+(?:amministrativo \(REA\)\s+)?([A-Z]{2})\s*-\s*(\d+)/);
    campi.SIGLAPROVINCIA_REA = mRea ? mRea[1] : "";
    campi.numero_rea = mRea ? mRea[2] : "";

    // unico socio (solo società di capitali). Fonte principale: il numero di soci nel riquadro "L'impresa in cifre".
    // In mancanza, la dicitura "socio unico" nel paragrafo dei soci (non nello statuto, dove "unipersonale"
    // può riferirsi all'organo amministrativo). Il pannello lo mostra sempre come dato da verificare.
    var unico = false;
    if (campi._tipo === "capitali") {
      var nSoci = numeroSoci(righe);
      if (nSoci !== null) unico = nSoci === 1;
      else {
        var iSoci = -1;
        for (var q = 0; q < L.length; q++) if (/^\s*\d+\s+Soci e titolari/.test(L[q]) && !/\.{3}/.test(L[q])) iSoci = q;
        if (iSoci >= 0) unico = /\b(UNICO SOCIO|SOCIO UNICO)\b/i.test(L.slice(iSoci, iSoci + 40).join(" "));
        if (/\b(UNIPERSONALE|CON SOCIO UNICO)\s*$/i.test(campi.ragione_sociale)) unico = true;
      }
      // conferma: la qualifica "Socio Unico" tra i titolari di altre cariche o qualifiche in carica
      if (!unico && nSoci === null && socioUnicoInCarica(righe)) unico = true;
    }
    campi._unico = unico;

    var dir = direzioneCoordinamento(righe);
    if (dir) {
      campi._direzione = dir.nome;
      campi._direzioneAttiva = dir.fonte === "registro";
      if (dir.fonte === "bilancio") avvisi.push("Direzione e coordinamento di " + dir.nome +
        ": risulta solo dall'ultimo bilancio depositato, non dal Registro Imprese. Da verificare.");
    }

    ["ragione_sociale", "codice_fiscale", "registro_imprese", "numero_rea"].forEach(function (k) {
      if (!campi[k]) avvisi.push("Non trovato: " + k.replace(/_/g, " "));
    });
    return { tipo: "camerale", titolo: titolo ? capitalizza(titolo) : "Visura camerale", societa: campi, avvisi: avvisi };
  }

  // ------------------------------------------------------------------ composizione dei testi

  var MODELLI = {
    terreno: "Comune di #comune, sezione #codicesezionecensuaria, foglio #foglio, particella #PARTICELLA, #destinazione, classe #classe, di ettari #ettari.#are.#centiare, R.D. euro #redditodominicale, R.A. euro #redditoagrario",
    fabbricato: "Comune di #comune, sezione #sezioneurbana, foglio #foglio, particella #particella, subalterno #subalterno, #zonacensuaria, #indirizzo n. #numerocivico, piano #piano, categoria #categoria, classe #classe, consistenza #consistenza, superficie catastale totale mq. #superficiecatastale, rendita euro #rendita",
    societa: "\"#ragione_sociale\"\n#unico socio, con sede in #comune_sede, #indirizzo_sede n. #civico_sede, capitale sociale euro #capitale_sociale, interamente versato, iscritta presso il Registro delle Imprese tenuto dalla Camera di Commercio di #registro_imprese al numero di iscrizione e codice fiscale #codice_fiscale, R.E.A. n. #SIGLAPROVINCIA_REA-#numero_rea, soggetta all'attività di direzione e coordinamento di #nome_società"
  };

  // valori pronti per i modelli (maiuscole/minuscole, "con unico", versato)
  function valori(tipo, campi, opz) {
    opz = opz || {};
    var v = {}, cap = opz.minuscole !== false;
    Object.keys(campi).forEach(function (k) { v[k.toLowerCase()] = campi[k] == null ? "" : String(campi[k]); });
    if (cap) {
      ["comune", "indirizzo", "comune_sede", "indirizzo_sede", "registro_imprese"].forEach(function (k) {
        if (v[k]) v[k] = capitalizza(v[k]);
      });
    }
    if (tipo === "societa") {
      v.unico = campi._unico ? "con unico" : "";
      v["nome_società"] = v.nome_societa = (campi._direzioneAttiva && campi._direzione) ? campi._direzione : "";
      if (campi._tipo === "persone") v.capitale_sociale = "";
      v._versato = v.capitale_sociale
        ? ((!campi._versato || campi._versato === campi.capitale_sociale) ? "interamente versato" : "versato euro " + campi._versato)
        : "";
    }
    return v;
  }

  function componi(modello, campi, tipo, opz) {
    var v = valori(tipo, campi, opz);
    return String(modello).split("\n").map(function (riga) {
      var segmenti = riga.split(", ");
      var fuori = [];
      segmenti.forEach(function (seg) {
        if (/^\s*interamente versato\s*$/i.test(seg) && tipo === "societa") {
          if (v._versato) fuori.push(seg.replace(/interamente versato/i, v._versato));
          return;
        }
        var segni = [], re = /#([A-Za-z_\u00C0-\u00FF]+)/g, m;
        while ((m = re.exec(seg))) segni.push({ nome: m[1].toLowerCase(), da: m.index, a: m.index + m[0].length });
        if (!segni.length) { fuori.push(seg); return; }
        if (!v[segni[0].nome]) return;                         // manca il dato principale: si omette il segmento
        var testo = "", pos = 0;
        segni.forEach(function (sg, idx) {
          var prima = seg.slice(pos, sg.da);
          if (v[sg.nome]) testo += prima + v[sg.nome];
          else if (idx === 0) testo += prima;                  // (non accade: gestito sopra)
          pos = sg.a;
        });
        testo += seg.slice(pos);
        fuori.push(testo);
      });
      return fuori.join(", ");
    }).filter(function (r) { return pulisci(r) !== ""; }).join("\n");
  }

  // ------------------------------------------------------------------ ingresso principale

  function analizza(pagine) {
    var righe = costruisciRighe(pagine);
    var tipo = riconosci(righe);
    if (tipo === "catasto") return analizzaCatasto(righe);
    if (tipo === "camerale") return analizzaCamerale(righe);
    return { tipo: null, titolo: "Documento non riconosciuto", avvisi: ["Il PDF non sembra una visura catastale o camerale (oppure è una scansione senza testo)."] };
  }

  var api = {
    analizza: analizza, componi: componi, MODELLI: MODELLI, capitalizza: capitalizza,
    costruisciRighe: costruisciRighe, separaIndirizzo: separaIndirizzo, numeroSoci: numeroSoci, socioUnicoInCarica: socioUnicoInCarica, direzioneCoordinamento: direzioneCoordinamento
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Visure = api;
})(this);
