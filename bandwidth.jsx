// Bandwidth : les débits descendant et montant de ce Mac, et la latence vers la box et vers le fournisseur,
// sur les 30 dernières minutes. Successeur du bandwidth.sh de GeekTool (rrdtool + ImageMagick + trois geeklets).
// Tout se passe ici, en JavaScript : mesure (netstat, ping, traceroute), mémoire (localStorage), dessin (SVG).
// Maquette validée par Fafa le 12 novembre 2026.
// Au-dessus de l'axe : le download en aire blanche, l'upload en aire rose PAR-DESSUS, à la même échelle
// (le rose signale ce qui sort du Mac). En dessous : la latence, box en blanc, fournisseur en rose, en traits fins.

import { run } from 'uebersicht';

// ==========================================================================
// 1. MES RÉGLAGES : n'écrire ici que ce qu'on veut changer
// ==========================================================================
// Les valeurs par défaut complètes sont dans DEFAUTS, juste en dessous.
// Une clé absente, mal écrite ou d'un mauvais type garde sa valeur par défaut.
// Exemple : const MES_REGLAGES = { general: { top: 60 }, echelles: { debits: { max: 1000 } } };
const MES_REGLAGES = {
	general: {
		largeur: 320,   // la colonne de gauche, jusque sous l'Europe
	},
	latence: {
		bande: 48,      // deux fois plus haute que la maquette (choix de Fafa) ; l'axe ne bouge pas, la bande descend
	},
};

// Réglages personnels (position sur l'écran) : ils passent par-dessus MES_REGLAGES.
// Vide dans la version publiée sur fafag.fr : l'outil de publication retire ce qui est entre les deux repères.
const PERSO = {
};

// ==========================================================================
// 2. VALEURS PAR DÉFAUT
// ==========================================================================
const DEFAUTS = {
	general: {
		top: 20,                      // position en points depuis le coin haut gauche du bureau
		left: 20,
		largeur: 300,                 // du graphique
		hauteur: 80,                  // des débits, au-dessus de l'axe
		police: '"SF Pro Rounded", ui-rounded, system-ui, sans-serif',
		taille: 12,                   // des valeurs à droite
		taille_echelle: 10,           // des échelles, au-dessus et en dessous
		ecart_valeurs: 14,            // entre le graphique et les valeurs à droite
	},
	mesure: {
		pas: 2,                       // une mesure des débits toutes les « pas » secondes
		fenetre: 30,                  // minutes affichées
		paquet: 6,                    // mesures regroupées par paquet (6 × 2 s = 12 s, un paquet tous les 2 points)
		lissage: 'doux',              // 'fidele' (le pic de chaque paquet), 'doux' (la moyenne), 'tres_doux' (moyenne glissante sur 3 paquets)
	},
	latence: {
		afficher: true,
		pas: 10,                      // un ping toutes les « pas » secondes
		box: true,
		fournisseur: true,            // le premier routeur après la box, trouvé par traceroute
		cible_traceroute: '1.1.1.1',  // une adresse lointaine, seulement pour trouver le chemin
		ecart: 8,                     // entre l'axe et la bande des latences
		bande: 24,                    // hauteur de la bande
		epaisseur: 1.5,
	},
	echelles: {
		// type : 'lineaire' ou 'log' ; max : 'auto' ou un nombre fixe (ce qui dépasse est écrêté au bord) ;
		// min : le bas de l'échelle en log (en linéaire, le bas est 0) ; plancher : en 'auto', le max ne descend pas plus bas
		debits: { type: 'lineaire', max: 'auto', min: 0.1, plancher: 1 },     // en Mbit/s
		latences: { type: 'log', max: 'auto', min: 1, plancher: 100 },        // en ms
	},
	couleurs: {
		download: '#F8F8F2',
		upload: '#F92672',
		box: '#F8F8F2',
		fournisseur: '#F92672',
		axe: '#3B3A32',
		valeurs: '#F8F8F2',
		unites: '#75715E',
		echelles: '#75715E',
	},
};

// Fusion tolérante : chaque valeur de MES_REGLAGES remplace celle de DEFAUTS si son type convient.
const fusionner = (defaut, perso) => {
	if (Array.isArray(defaut)) {
		if (!Array.isArray(perso)) return defaut;
		return perso.map((p, i) => fusionner(defaut[Math.min(i, defaut.length - 1)], p));
	}
	if (defaut && typeof defaut === 'object') {
		const resultat = {};
		const source = perso && typeof perso === 'object' ? perso : {};
		for (const cle of Object.keys(defaut)) resultat[cle] = fusionner(defaut[cle], source[cle]);
		return resultat;
	}
	const typeAccepte = typeof perso === typeof defaut || (typeof defaut === 'string' && typeof perso === 'number');
	return perso !== undefined && typeAccepte ? perso : defaut;
};

const R = fusionner(fusionner(DEFAUTS, MES_REGLAGES), PERSO);
const G = R.general, M = R.mesure, LA = R.latence, C = R.couleurs;
const PAS = Math.max(1, M.pas) * 1000;
const FENETRE = Math.max(1, M.fenetre) * 60000;
const PAQUET = Math.max(1, M.paquet) * PAS;
const PAS_LATENCE = Math.max(PAS, LA.pas * 1000);
const BANDE = LA.afficher ? LA.ecart + LA.bande : 0;     // hauteur sous l'axe

// ==========================================================================
// 3. MÉMOIRE : l'historique survit au redémarrage d'Übersicht (localStorage)
// ==========================================================================
// debits : [{ t, d, u }] en Mbit/s ; latences : [{ t, b, f }] en ms (null = pas de réponse)
const CLE = 'capsules-bandwidth';
const lire = () => { try { return JSON.parse(localStorage.getItem(CLE)) || {}; } catch (e) { return {}; } };
const memoire = lire();
const H = {
	debits: Array.isArray(memoire.debits) ? memoire.debits : [],
	latences: Array.isArray(memoire.latences) ? memoire.latences : [],
	saut: typeof memoire.saut === 'string' ? memoire.saut : '',    // le routeur du fournisseur
	passerelle: typeof memoire.passerelle === 'string' ? memoire.passerelle : '',
	quandSaut: Number(memoire.quandSaut) || 0,
};
const oublier = () => {                        // au-delà de la fenêtre, on oublie
	const limite = Date.now() - FENETRE - PAQUET;
	while (H.debits.length && H.debits[0].t < limite) H.debits.shift();
	while (H.latences.length && H.latences[0].t < limite) H.latences.shift();
};
oublier();
let ecritures = 0;
const ecrire = (force) => {
	if (!force && ++ecritures % 5) return;      // pas besoin d'écrire toutes les 2 s
	try { localStorage.setItem(CLE, JSON.stringify(H)); } catch (e) {}
};

// ==========================================================================
// 4. MESURES
// ==========================================================================
// Débits : les compteurs d'octets de l'interface qui porte la route par défaut (en0, en1, un VPN…).
// Les colonnes de netstat se comptent depuis la fin : une interface sans adresse matérielle (VPN) en a une de moins.
const COMPTEURS = String.raw`r=$(route -n get default 2>/dev/null)
i=$(echo "$r" | awk '/interface:/{print $2}')
g=$(echo "$r" | awk '/gateway:/{print $2}')
[ -n "$i" ] && netstat -ibn -I "$i" | awk -v i="$i" -v g="$g" '$3 ~ /^<Link/ { print i, g, $(NF-4), $(NF-1); exit }'`;

// Un ping, une réponse en ms (rien si pas de réponse en 1 s)
const ping = ip => `ping -c 1 -t 1 ${ip} 2>/dev/null | awk -F/ '/round-trip/{print $5}'`;
const IP = /^\d{1,3}(\.\d{1,3}){3}$/;
const PRIVEE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/;

let precedent = null;           // { t, interface, entrant, sortant }
let mesureEnCours = false, latenceEnCours = false, tracerouteEnCours = false;
let dernierPing = 0;

const mesurerDebits = () => {
	if (mesureEnCours) return Promise.resolve();
	mesureEnCours = true;
	return run(COMPTEURS).then(sortie => {
		const [iface, passerelle, entrant, sortant] = sortie.trim().split(/\s+/);
		const t = Date.now(), e = Number(entrant), s = Number(sortant);
		if (!iface || !isFinite(e) || !isFinite(s)) { precedent = null; return; }     // hors ligne : un trou
		if (IP.test(passerelle || '') && passerelle !== H.passerelle) { H.passerelle = passerelle; H.saut = ''; }   // autre réseau
		const p = precedent;
		precedent = { t, iface, e, s };
		// Une mesure n'est gardée que si elle suit la précédente sur la même interface, sans veille entre les deux,
		// et si les compteurs n'ont pas reculé (changement d'interface, redémarrage) : sinon, pas de pic absurde.
		if (!p || p.iface !== iface || t - p.t > 3 * PAS || e < p.e || s < p.s) return;
		const duree = (t - p.t) / 1000;
		H.debits.push({ t, d: (e - p.e) * 8 / duree / 1e6, u: (s - p.s) * 8 / duree / 1e6 });
	}).catch(() => {}).then(() => { mesureEnCours = false; });
};

// Le routeur du fournisseur : le premier saut public après la box. Cherché une fois par réseau, puis toutes les heures.
const chercherSaut = () => {
	if (tracerouteEnCours || !IP.test(LA.cible_traceroute)) return;
	tracerouteEnCours = true;
	run(`traceroute -n -m 5 -q 1 -w 1 ${LA.cible_traceroute} 2>/dev/null | awk '{print $2}'`)
		.then(sortie => {
			const sauts = sortie.split('\n').map(x => x.trim()).filter(x => IP.test(x));
			const saut = sauts.find(x => x !== H.passerelle && !PRIVEE.test(x));
			if (saut) { H.saut = saut; H.quandSaut = Date.now(); ecrire(true); }
		})
		.catch(() => {})
		.then(() => { tracerouteEnCours = false; });
};

const mesurerLatences = () => {
	if (!LA.afficher || latenceEnCours || Date.now() - dernierPing < PAS_LATENCE - 500) return;
	if (LA.fournisseur && (!H.saut || Date.now() - H.quandSaut > 3600000)) chercherSaut();
	const box = LA.box && IP.test(H.passerelle) ? H.passerelle : '';
	const fai = LA.fournisseur && IP.test(H.saut) ? H.saut : '';
	if (!box && !fai) return;
	latenceEnCours = true;
	dernierPing = Date.now();
	run(`b=$(${box ? ping(box) : 'true'}); f=$(${fai ? ping(fai) : 'true'}); echo "$b;$f"`)
		.then(sortie => {
			const [b, f] = sortie.trim().split(';').map(x => (x === '' ? null : Number(x)));
			H.latences.push({ t: dernierPing, b: Number.isFinite(b) ? b : null, f: Number.isFinite(f) ? f : null });   // isFinite(null) vaudrait true
		})
		.catch(() => {})
		.then(() => { latenceEnCours = false; });
};

// ==========================================================================
// 5. DESSIN
// ==========================================================================
// Courbe par les milieux de segments (cheminLisse de soleil-lune.jsx) : elle ne dépasse jamais, donc jamais sous zéro.
const f2 = p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
const milieu = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
const cheminLisse = points => {
	if (points.length < 3) return points.map((p, i) => `${i ? 'L' : 'M'}${f2(p)}`).join('');
	let d = `M${f2(points[0])}L${f2(milieu(points[0], points[1]))}`;
	for (let i = 1; i < points.length - 1; i++) d += `Q${f2(points[i])} ${f2(milieu(points[i], points[i + 1]))}`;
	return d + `L${f2(points[points.length - 1])}`;
};

// Découpe en morceaux continus : un trou (veille, hors ligne) coupe la courbe au lieu de la relier
const morceaux = (liste, ecartMax) => {
	const res = []; let cur = [], avant = null;
	for (const p of liste) {
		if (!p || (avant && p.t - avant.t > ecartMax)) { if (cur.length) res.push(cur); cur = []; }
		if (p) { cur.push(p); avant = p; }
	}
	if (cur.length) res.push(cur);
	return res.filter(m => m.length > 1);
};

// Paquets fixes dans le temps (ils ne glissent pas d'un rafraîchissement à l'autre) ; null = paquet vide
const paquets = maintenant => {
	const res = [], debut = Math.floor((maintenant - FENETRE) / PAQUET), fin = Math.floor(maintenant / PAQUET);
	const parPaquet = new Map();
	for (const m of H.debits) {
		const k = Math.floor(m.t / PAQUET);
		if (k < debut) continue;
		if (!parPaquet.has(k)) parPaquet.set(k, []);
		parPaquet.get(k).push(m);
	}
	for (let k = debut; k <= fin; k++) {
		const l = parPaquet.get(k);
		if (!l) { res.push(null); continue; }
		const moy = cle => l.reduce((s, m) => s + m[cle], 0) / l.length;
		const max = cle => Math.max(...l.map(m => m[cle]));
		res.push({ t: moy('t'), d: M.lissage === 'fidele' ? max('d') : moy('d'), u: M.lissage === 'fidele' ? max('u') : moy('u') });
	}
	return M.lissage === 'tres_doux' ? glisser(res, ['d', 'u']) : res;
};
// Moyenne glissante sur 3, sans enjamber un trou
const glisser = (liste, cles) => liste.map((p, j) => {
	if (!p) return null;
	const voisins = [liste[j - 1], p, liste[j + 1]].filter(Boolean);
	const q = { ...p };
	for (const c of cles) {
		const v = voisins.filter(x => x[c] !== null);
		q[c] = p[c] === null ? null : v.reduce((s, x) => s + x[c], 0) / v.length;
	}
	return q;
});

// Une échelle : f(v) entre 0 (l'axe) et 1 (le bord), écrêtée ; et son libellé
const rond = v => { const e = Math.pow(10, Math.floor(Math.log10(v))); return [1, 2, 5, 10].map(k => k * e).find(n => n >= v); };
const echelle = (E, pic, unite) => {
	const log = E.type === 'log';
	const min = Math.max(1e-6, Number(E.min) || 1);
	let max = Number(E.max);
	if (E.max === 'auto' || !(max > 0)) {
		const haut = Math.max(Number(E.plancher) || 0, pic);
		max = log ? Math.pow(10, Math.ceil(Math.log10(Math.max(haut, min * 10)))) : rond(Math.max(haut, 1e-6));
	}
	const f = log
		? v => Math.min(1, Math.max(0, Math.log10(Math.max(v, min) / min) / Math.log10(max / min)))
		: v => Math.min(1, Math.max(0, v / max));
	const nombre = v => String(v).replace('.', ',');
	return { f, libelle: `${nombre(max)} ${unite}` };      // le haut de l'échelle seulement, en linéaire comme en log (choix de Fafa)
};

const texte = v => (v === null || v === undefined || !isFinite(v)) ? '–' : v < 10 ? v.toFixed(1).replace('.', ',') : String(Math.round(v));

// ==========================================================================
// 6. ÜBERSICHT : rafraîchissement et dessin
// ==========================================================================
export const initialState = { tic: 0 };
export const updateState = (evenement, avant) => evenement.type === 'TIC' ? { tic: Date.now() } : avant;

export const command = dispatch => {
	mesurerLatences();
	mesurerDebits().then(() => { oublier(); ecrire(); dispatch({ type: 'TIC' }); });
};
export const refreshFrequency = PAS;

export const className = `
	top: ${G.top}px;
	left: ${G.left}px;
	user-select: none;
	pointer-events: none;
	font-family: ${G.police};
	.bw { display: flex; align-items: flex-start; gap: ${G.ecart_valeurs}px; }
	.bw svg { display: block; overflow: visible; }
	.valeurs { display: grid; grid-template-rows: ${G.hauteur}px auto; font-size: ${G.taille}px; font-variant-numeric: tabular-nums; white-space: nowrap; }
	.groupe { display: grid; gap: 6px; }
	.debits { align-self: end; padding-bottom: 4px; }
	.latences { padding-top: ${Math.max(0, LA.ecart - 1)}px; }
	.valeur { display: flex; align-items: center; gap: 7px; }
	.valeur b { font-weight: 600; min-width: 3.2ch; text-align: right; color: ${C.valeurs}; }
	.unite { color: ${C.unites}; }
	.pastille { width: 16px; height: 8px; border-radius: 4px; flex: none; }
	.point { width: 8px; height: 8px; border-radius: 50%; flex: none; margin: 0 4px; }
`;

export const render = () => {
	const maintenant = Date.now();
	const L = G.largeur, Hd = G.hauteur;
	const x = t => L - (maintenant - t) / FENETRE * L;

	// Débits : upload par-dessus download, même échelle
	const liste = paquets(maintenant);
	const picD = Math.max(0, ...liste.filter(Boolean).map(p => Math.max(p.d, p.u)));
	const ED = echelle(R.echelles.debits, picD, 'Mbit/s');
	const yD = v => Hd - ED.f(v) * (Hd - 1);
	const aire = cle => morceaux(liste, 2 * PAQUET)
		.map(m => {
			const pts = m.map(p => [x(p.t), yD(p[cle])]);
			return cheminLisse(pts) + `L${f2([pts[pts.length - 1][0], Hd])}L${f2([pts[0][0], Hd])}Z`;
		}).join('');

	// Latences : sous l'axe, 0 (ou le min en log) contre l'axe, plus c'est lent, plus le trait descend
	let latences = null;
	if (LA.afficher) {
		const haut = Hd + LA.ecart;
		const lat = M.lissage === 'tres_doux' ? glisser(H.latences, ['b', 'f']) : H.latences;
		const valeurs = lat.flatMap(l => [LA.box ? l.b : null, LA.fournisseur ? l.f : null]).filter(v => v !== null);
		const EL = echelle(R.echelles.latences, Math.max(0, ...valeurs), 'ms');
		const yL = v => haut + EL.f(v) * LA.bande;
		const trait = cle => morceaux(lat.filter(l => l[cle] !== null), 2 * PAS_LATENCE)
			.map(m => cheminLisse(m.map(l => [x(l.t), yL(l[cle])]))).join('');
		latences = (
			<g>
				<clipPath id="bw-clip-l"><rect y={haut - 2} width={L} height={LA.bande + 4} /></clipPath>
				<g clipPath="url(#bw-clip-l)" fill="none" strokeWidth={LA.epaisseur} strokeLinecap="round" strokeLinejoin="round">
					{LA.fournisseur && <path d={trait('f')} stroke={C.fournisseur} />}
					{LA.box && <path d={trait('b')} stroke={C.box} />}
				</g>
				<text x={0} y={haut + LA.bande + 12} fill={C.echelles} fontSize={G.taille_echelle}>{EL.libelle}</text>
			</g>
		);
	}

	const dernier = H.debits[H.debits.length - 1];
	const frais = dernier && maintenant - dernier.t < 3 * PAS ? dernier : null;
	const derniereLat = H.latences[H.latences.length - 1];
	const latFraiche = derniereLat && maintenant - derniereLat.t < 3 * PAS_LATENCE ? derniereLat : null;

	return (
		<div className="bw">
			<svg width={L} height={Hd + BANDE + 2} viewBox={`0 0 ${L} ${Hd + BANDE + 2}`}>
				<text x={0} y={-6} fill={C.echelles} fontSize={G.taille_echelle}>{ED.libelle}</text>
				<line x1={0} x2={L} y1={Hd + 0.5} y2={Hd + 0.5} stroke={C.axe} strokeWidth={1} />
				<clipPath id="bw-clip-d"><rect width={L} height={Hd + 1} /></clipPath>
				<g clipPath="url(#bw-clip-d)">
					<path d={aire('d')} fill={C.download} />
					<path d={aire('u')} fill={C.upload} />
				</g>
				{latences}
			</svg>
			<div className="valeurs">
				<div className="groupe debits">
					<div className="valeur"><span className="pastille" style={{ background: C.download }} /><b>{texte(frais && frais.d)}</b><span className="unite">Mbit/s</span></div>
					<div className="valeur"><span className="pastille" style={{ background: C.upload }} /><b>{texte(frais && frais.u)}</b><span className="unite">Mbit/s</span></div>
				</div>
				{LA.afficher && (
					<div className="groupe latences">
						{LA.box && <div className="valeur"><span className="point" style={{ background: C.box }} /><b>{texte(latFraiche && latFraiche.b)}</b><span className="unite">ms box</span></div>}
						{LA.fournisseur && <div className="valeur"><span className="point" style={{ background: C.fournisseur }} /><b>{texte(latFraiche && latFraiche.f)}</b><span className="unite">ms fournisseur</span></div>}
					</div>
				)}
			</div>
		</div>
	);
};
