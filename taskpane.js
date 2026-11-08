/* Pannello Visure: carica i PDF, mostra i dati estratti, inserisce i testi in Word. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var inWord = false;
  var documenti = [];          // { id, nome, ris, voci: [{ tipo, campi, testo, sel, modificato, avviso }] }
  var contatore = 0;
  var CHIAVE = "visure.impostazioni";

  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

  // ---------------------------------------------------------------- impostazioni

  function predefiniti() {
    return {
      fabbricato: Visure.MODELLI.fabbricato, terreno: Visure.MODELLI.terreno, societa: Visure.MODELLI.societa,
      minuscole: true, separatore: "a-capo"
    };
  }
  var imp = predefiniti();
  try {
    var salvate = JSON.parse(window.localStorage.getItem(CHIAVE) || "null");
    // testo dei terreni della versione precedente (senza la parola "classe"): sostituito dal nuovo predefinito
    var TERRENO_V1 = "Comune di #comune, sezione #codicesezionecensuaria, foglio #foglio, particella #PARTICELLA, #destinazione, #classe, di ettari #ettari.#are.#centiare, R.D. euro #redditodominicale, R.A. euro #redditoagrario";
    if (salvate && salvate.terreno === TERRENO_V1) delete salvate.terreno;
    if (salvate) Object.keys(imp).forEach(function (k) { if (salvate[k] !== undefined) imp[k] = salvate[k]; });
  } catch (e) { /* memoria del browser non disponibile */ }

  // memorizza solo ciò che differisce dai predefiniti, così i futuri aggiornamenti dei testi arrivano a tutti
  function salva() {
    var pred = predefiniti(), diverse = {};
    Object.keys(imp).forEach(function (k) { if (imp[k] !== pred[k]) diverse[k] = imp[k]; });
    try { window.localStorage.setItem(CHIAVE, JSON.stringify(diverse)); } catch (e) { /* ignora */ }
  }

  function mostraImpostazioni() {
    $("modFabbricato").value = imp.fabbricato;
    $("modTerreno").value = imp.terreno;
    $("modSocieta").value = imp.societa;
    $("minuscole").checked = imp.minuscole;
    $("separatore").value = imp.separatore;
  }

  // ---------------------------------------------------------------- composizione

  function componi(v) {
    var modello = v.tipo === "fabbricato" ? imp.fabbricato : (v.tipo === "terreno" ? imp.terreno : imp.societa);
    return Visure.componi(modello, v.campi, v.tipo, { minuscole: imp.minuscole });
  }

  function ricalcola(tutti) {
    documenti.forEach(function (d) {
      d.voci.forEach(function (v) { if (tutti || !v.modificato) { v.testo = componi(v); v.modificato = false; } });
    });
  }

  // ---------------------------------------------------------------- lettura PDF

  function leggiPdf(file) {
    return file.arrayBuffer().then(function (buf) {
      return window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    }).then(function (pdf) {
      var pagine = [], catena = Promise.resolve();
      for (var p = 1; p <= pdf.numPages; p++) {
        (function (n) {
          catena = catena.then(function () { return pdf.getPage(n); })
            .then(function (pg) { return pg.getTextContent(); })
            .then(function (tc) {
              pagine.push({
                items: tc.items.map(function (it) {
                  return { str: it.str, x: it.transform[4], y: it.transform[5], w: it.width };
                })
              });
            });
        })(p);
      }
      return catena.then(function () { return pagine; });
    });
  }

  function aggiungiFile(lista) {
    Array.prototype.forEach.call(lista, function (file) {
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
        stato("«" + file.name + "» non è un PDF.", "err");
        return;
      }
      var d = { id: ++contatore, nome: file.name, ris: null, voci: [], inLettura: true, filtro: "" };
      documenti.push(d);
      disegna();
      leggiPdf(file).then(function (pagine) {
        d.ris = Visure.analizza(pagine);
        if (d.ris.tipo === "catasto") {
          d.voci = d.ris.beni.map(function (b) {
            // con molti immobili (visura per soggetto) si parte senza selezione: si scelgono quelli dell'atto
            return { tipo: b.catasto === "F" ? "fabbricato" : "terreno", campi: b.campi, sel: d.ris.beni.length <= 3, modificato: false, avviso: b.avviso || "" };
          });
        } else if (d.ris.tipo === "camerale") {
          d.voci = [{ tipo: "societa", campi: d.ris.societa, sel: true, modificato: false, avviso: "" }];
        }
        d.voci.forEach(function (v) { v.testo = componi(v); });
      }).catch(function (e) {
        d.ris = { tipo: null, titolo: "Lettura non riuscita", avvisi: [/password/i.test(String(e && e.message)) ? "Il PDF è protetto da password." : "Impossibile leggere il PDF (" + (e && e.message ? e.message : e) + ")."] };
      }).then(function () { d.inLettura = false; disegna(); });
    });
  }

  // ---------------------------------------------------------------- interfaccia

  function el(tag, attr, figli) {
    var n = document.createElement(tag);
    Object.keys(attr || {}).forEach(function (k) {
      if (k === "testo") n.textContent = attr[k];
      else if (k === "classe") n.className = attr[k];
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), attr[k]);
      else n.setAttribute(k, attr[k]);
    });
    (figli || []).forEach(function (f) { if (f) n.appendChild(f); });
    return n;
  }

  function adatta(ta) { ta.style.height = "auto"; ta.style.height = (ta.scrollHeight + 2) + "px"; }

  function descrizione(d) {
    if (d.inLettura) return "Lettura in corso…";
    if (!d.ris || !d.ris.tipo) return d.ris ? d.ris.titolo : "";
    if (d.ris.tipo === "camerale") {
      var t = d.voci[0] && d.voci[0].campi._tipo;
      return "Visura camerale" + (t === "capitali" ? " · società di capitali" : t === "persone" ? " · società di persone" : "");
    }
    var f = d.voci.filter(function (v) { return v.tipo === "fabbricato"; }).length;
    var tr = d.voci.length - f;
    var parti = [];
    if (f) parti.push(f + (f === 1 ? " fabbricato" : " fabbricati"));
    if (tr) parti.push(tr + (tr === 1 ? " terreno" : " terreni"));
    return d.ris.titolo + " · " + parti.join(", ");
  }

  function disegna() {
    var cont = $("risultati");
    cont.innerHTML = "";
    documenti.forEach(function (d) {
      var card = el("section", { classe: "card" });
      card.appendChild(el("div", { classe: "file-testa" }, [
        el("div", {}, [
          el("div", { classe: "file-tipo", testo: descrizione(d) }),
          el("div", { classe: "file-nome", testo: d.nome })
        ]),
        el("button", { classe: "chiudi", title: "Togli questa visura", testo: "✕", type: "button",
          onclick: function () { documenti = documenti.filter(function (x) { return x !== d; }); disegna(); } })
      ]));
      if (d.inLettura) { card.appendChild(el("div", { classe: "attesa", testo: "Sto leggendo il PDF…" })); cont.appendChild(card); return; }
      (d.ris && d.ris.avvisi || []).forEach(function (a) { card.appendChild(el("div", { classe: "avviso", testo: a })); });

      if (d.voci.length > 1) {
        var cerca = el("input", { type: "search", placeholder: "Filtra (foglio, particella, via, categoria…)", value: d.filtro });
        cerca.addEventListener("input", function () { d.filtro = cerca.value; applicaFiltro(card, d); });
        card.appendChild(el("div", { classe: "strumenti" }, [
          cerca,
          el("button", { classe: "link", type: "button", testo: "Tutti", onclick: function () { selezionaVisibili(card, d, true); } }),
          el("button", { classe: "link", type: "button", testo: "Nessuno", onclick: function () { selezionaVisibili(card, d, false); } })
        ]));
      }
      d.voci.forEach(function (v, idx) {
        var cb = el("input", { type: "checkbox" });
        cb.checked = v.sel;
        cb.addEventListener("change", function () { v.sel = cb.checked; aggiornaBarra(); });
        var ta = el("textarea", { spellcheck: "false" });
        ta.value = v.testo;
        ta.addEventListener("input", function () { v.testo = ta.value; v.modificato = true; adatta(ta); });
        var corpo = el("div", { classe: "corpo" }, [ta]);
        if (v.avviso) corpo.appendChild(el("div", { classe: "avviso", testo: v.avviso }));
        if (v.tipo === "societa") {
          if (v.campi._tipo === "capitali") {
            var cu = el("input", { type: "checkbox" });
            cu.checked = !!v.campi._unico;
            cu.addEventListener("change", function () {
              v.campi._unico = cu.checked; v.testo = componi(v); v.modificato = false; ta.value = v.testo; adatta(ta);
            });
            corpo.appendChild(el("label", { classe: "check" }, [cu, document.createTextNode("con unico socio (da verificare sulla visura)")]));
          }
          if (v.campi._versato && v.campi.capitale_sociale && v.campi._versato !== v.campi.capitale_sociale) {
            corpo.appendChild(el("div", { classe: "avviso", testo: "Capitale non interamente versato: sottoscritto euro " + v.campi.capitale_sociale + ", versato euro " + v.campi._versato + "." }));
          }
        }
        var riga = el("div", { classe: "bene", "data-i": String(idx) }, [cb, corpo]);
        card.appendChild(riga);
        setTimeout(function () { adatta(ta); }, 0);
      });
      if (d.ris && d.ris.tipo && !d.voci.length) card.appendChild(el("div", { classe: "vuoto", testo: "Nessun dato estratto." }));
      cont.appendChild(card);
      applicaFiltro(card, d);
    });
    aggiornaBarra();
  }

  function visibile(v, filtro) {
    if (!filtro) return true;
    var parole = filtro.toLowerCase().split(/\s+/).filter(Boolean);
    var t = v.testo.toLowerCase();
    return parole.every(function (p) { return t.indexOf(p) >= 0; });
  }

  function applicaFiltro(card, d) {
    Array.prototype.forEach.call(card.querySelectorAll(".bene"), function (n) {
      var v = d.voci[+n.getAttribute("data-i")];
      n.style.display = visibile(v, d.filtro) ? "" : "none";
    });
  }

  function selezionaVisibili(card, d, valore) {
    Array.prototype.forEach.call(card.querySelectorAll(".bene"), function (n) {
      if (n.style.display === "none") return;
      var v = d.voci[+n.getAttribute("data-i")];
      v.sel = valore;
      n.querySelector('input[type="checkbox"]').checked = valore;
    });
    aggiornaBarra();
  }

  function selezionati() {
    var out = [];
    documenti.forEach(function (d) {
      d.voci.forEach(function (v) { if (v.sel && visibile(v, d.filtro) && v.testo.trim()) out.push(v); });
    });
    return out;
  }

  function aggiornaBarra() {
    var n = selezionati().length;
    $("barra").hidden = documenti.length === 0;
    $("conteggio").textContent = n === 0 ? "Nessun testo selezionato" : (n === 1 ? "1 testo selezionato" : n + " testi selezionati");
    $("inserisci").disabled = !(n && inWord);
    $("copia").disabled = !n;
  }

  function testoFinale() {
    var sep = imp.separatore === "pv" ? "; " : (imp.separatore === "pv-a-capo" ? ";\n" : "\n");
    return selezionati().map(function (v) { return v.testo.trim(); }).join(sep);
  }

  function stato(msg, tipo) {
    var s = $("stato");
    s.textContent = msg || "";
    s.className = "stato" + (tipo ? " " + tipo : "");
  }

  // ---------------------------------------------------------------- Word

  function inserisci() {
    var testo = testoFinale();
    if (!testo || !inWord) return;
    Word.run(function (ctx) {
      var sel = ctx.document.getSelection();
      var r = sel.insertText(testo, "Replace");
      r.select("End");
      return ctx.sync();
    }).then(function () {
      stato("Inserito nel documento.", "ok");
    }).catch(function (e) {
      stato("Inserimento non riuscito" + (e && e.message ? ": " + e.message : "."), "err");
    });
  }

  function copia() {
    var testo = testoFinale();
    if (!testo) return;
    var riserva = function () {
      var ta = document.createElement("textarea");
      ta.value = testo; document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      stato(ok ? "Copiato negli appunti." : "Copia non riuscita.", ok ? "ok" : "err");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(testo).then(function () { stato("Copiato negli appunti.", "ok"); }, riserva);
    } else riserva();
  }

  // ---------------------------------------------------------------- avvio

  function collega() {
    mostraImpostazioni();
    var zona = $("zona"), input = $("file");
    input.addEventListener("change", function () { aggiungiFile(input.files); input.value = ""; });
    zona.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    ["dragenter", "dragover"].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); zona.classList.add("sopra"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); if (ev === "drop" || e.target === zona) zona.classList.remove("sopra"); });
    });
    document.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files) aggiungiFile(e.dataTransfer.files); });

    var modifica = function (chiave, campo, valore) {
      $(campo).addEventListener(valore ? "change" : "input", function () {
        imp[chiave] = valore ? $(campo)[valore] : $(campo).value;
        salva(); ricalcola(false); disegna();
      });
    };
    modifica("fabbricato", "modFabbricato");
    modifica("terreno", "modTerreno");
    modifica("societa", "modSocieta");
    modifica("minuscole", "minuscole", "checked");
    $("separatore").addEventListener("change", function () { imp.separatore = $("separatore").value; salva(); });
    $("ripristina").addEventListener("click", function () {
      var sep = imp.separatore;
      imp = predefiniti(); imp.separatore = sep;
      salva(); mostraImpostazioni(); ricalcola(true); disegna();
      stato("Testi predefiniti ripristinati.", "ok");
    });
    $("inserisci").addEventListener("click", inserisci);
    $("copia").addEventListener("click", copia);
    if (!window.pdfjsLib) stato("Libreria PDF non caricata: ricarica il pannello.", "err");
    disegna();
  }

  document.addEventListener("DOMContentLoaded", collega);
  if (window.Office && Office.onReady) {
    Office.onReady(function (info) {
      inWord = !!(info && info.host === Office.HostType.Word);
      if (!inWord) stato("Aperto fuori da Word: puoi provare l'estrazione e copiare i testi.");
      aggiornaBarra();
    });
  }
})();
