/**
 * AGEMOB — firebase.js
 * Camada de integração Firebase: Authentication, Firestore, realtime, persistência.
 * Não substitui nenhuma lógica de negócio do sistema principal.
 */

import { initializeApp }                            from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword,
         signInWithPopup, GoogleAuthProvider,
         signOut, onAuthStateChanged,
         setPersistence, browserLocalPersistence }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc,
         addDoc, setDoc, updateDoc, getDoc,
         getDocs, onSnapshot, query, orderBy,
         serverTimestamp, where }                   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ── Configuração ── */
const firebaseConfig = {
  apiKey:            "AIzaSyCZj9n20AautGaoJVsbtj7kBAd2KQifFv4",
  authDomain:        "agemob-prod.firebaseapp.com",
  projectId:         "agemob-prod",
  storageBucket:     "agemob-prod.firebasestorage.app",
  messagingSenderId: "822406821771",
  appId:             "1:822406821771:web:0b37238f6a9ff50804e18e"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

/* Persistência de sessão local */
setPersistence(auth, browserLocalPersistence).catch(console.error);

/* ── Coleções ── */
const COL_USUARIOS      = "usuarios";
const COL_AUTORIZACOES  = "autorizacoes";
const COL_PROPRIETARIOS = "proprietarios";
const COL_IMOVEIS       = "imoveis";
const COL_LOGS          = "logs";

/* ── Auth: Login e-mail/senha ── */
export async function fbLogin(email, senha) {
  return signInWithEmailAndPassword(auth, email, senha);
}

/* ── Auth: Login Google ── */
export async function fbLoginGoogle() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}

/* ── Auth: Logout ── */
export async function fbLogout() {
  return signOut(auth);
}

/* ── Auth: Observer de estado ── */
export function onAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

/* ── Firestore: buscar dados do usuário (imobiliária) ── */
export async function fbGetUsuario(uid) {
  try {
    const snap = await getDoc(doc(db, COL_USUARIOS, uid));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (e) {
    console.error("fbGetUsuario:", e);
    return null;
  }
}

/* ── Firestore: salvar/atualizar usuário ── */
export async function fbSalvarUsuario(uid, dados) {
  try {
    await setDoc(doc(db, COL_USUARIOS, uid), dados, { merge: true });
  } catch (e) {
    console.error("fbSalvarUsuario:", e);
    throw e;
  }
}

/* ── Firestore: criar autorização ── */
export async function fbCriarAutorizacao(dados) {
  try {
    const ref = await addDoc(collection(db, COL_AUTORIZACOES), {
      ...dados,
      dataCriacao: serverTimestamp(),
      status:      dados.status || "aguardando"
    });
    await fbLog("criacao", { autorizacaoId: ref.id, codigo: dados.codigo });
    return ref.id;
  } catch (e) {
    console.error("fbCriarAutorizacao:", e);
    throw e;
  }
}

/* ── Firestore: atualizar autorização ── */
export async function fbAtualizarAutorizacao(id, campos) {
  try {
    await updateDoc(doc(db, COL_AUTORIZACOES, id), campos);
    await fbLog("atualizacao", { autorizacaoId: id, campos: Object.keys(campos) });
  } catch (e) {
    console.error("fbAtualizarAutorizacao:", e);
    throw e;
  }
}

/* ── Firestore: registrar assinatura ── */
export async function fbAssinar(id, assinaturaBase64) {
  try {
    const agora = new Date();
    const venc  = new Date(); venc.setDate(venc.getDate() + 365);
    await updateDoc(doc(db, COL_AUTORIZACOES, id), {
      assinatura:     assinaturaBase64,
      status:         "ativa",
      dataAssinatura: serverTimestamp(),
      dataVencimento: venc.toLocaleDateString("pt-BR")
    });
    await fbLog("assinatura", { autorizacaoId: id });
  } catch (e) {
    console.error("fbAssinar:", e);
    throw e;
  }
}

/* ── Firestore: atualizar status ── */
export async function fbAtualizarStatus(id, novoStatus) {
  try {
    await updateDoc(doc(db, COL_AUTORIZACOES, id), {
      status: novoStatus
    });
    await fbLog("status", { autorizacaoId: id, novoStatus });
  } catch (e) {
    console.error("fbAtualizarStatus:", e);
    throw e;
  }
}

/* ── Firestore: buscar todas as autorizações (uma vez) ── */
export async function fbGetAutorizacoes(imobiliariaId) {
  try {
    const q = imobiliariaId
      ? query(collection(db, COL_AUTORIZACOES),
              where("imobiliaria", "==", imobiliariaId),
              orderBy("dataCriacao", "desc"))
      : query(collection(db, COL_AUTORIZACOES), orderBy("dataCriacao", "desc"));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ _fbId: d.id, ...d.data() }));
  } catch (e) {
    console.error("fbGetAutorizacoes:", e);
    return [];
  }
}

/* ── Firestore: listener em tempo real ── */
export function fbOnAutorizacoes(imobiliariaId, callback) {
  let q;
  try {
    q = imobiliariaId
      ? query(collection(db, COL_AUTORIZACOES),
              where("imobiliaria", "==", imobiliariaId),
              orderBy("dataCriacao", "desc"))
      : query(collection(db, COL_AUTORIZACOES), orderBy("dataCriacao", "desc"));
  } catch (e) {
    q = collection(db, COL_AUTORIZACOES);
  }
  return onSnapshot(q, snap => {
    const docs = snap.docs.map(d => ({ _fbId: d.id, ...d.data() }));
    callback(docs);
  }, err => console.error("fbOnAutorizacoes:", err));
}

/* ── Firestore: salvar proprietário ── */
export async function fbSalvarProprietario(dados) {
  try {
    const ref = await addDoc(collection(db, COL_PROPRIETARIOS), {
      ...dados,
      dataCadastro: serverTimestamp()
    });
    return ref.id;
  } catch (e) {
    console.error("fbSalvarProprietario:", e);
    throw e;
  }
}

/* ── Firestore: salvar imóvel ── */
export async function fbSalvarImovel(dados) {
  try {
    const ref = await addDoc(collection(db, COL_IMOVEIS), {
      ...dados,
      dataCadastro: serverTimestamp()
    });
    return ref.id;
  } catch (e) {
    console.error("fbSalvarImovel:", e);
    throw e;
  }
}

/* ── Firestore: log de auditoria ── */
export async function fbLog(tipo, detalhes) {
  try {
    await addDoc(collection(db, COL_LOGS), {
      tipo,
      detalhes,
      usuario: auth.currentUser ? auth.currentUser.uid : "anonimo",
      timestamp: serverTimestamp()
    });
  } catch (e) {
    /* logs nunca devem derrubar o fluxo principal */
    console.warn("fbLog silenciado:", e);
  }
}

/* ── Firestore: buscar autorização por código ── */
export async function fbGetAutorizacaoPorCodigo(codigo) {
  try {
    const q    = query(collection(db, COL_AUTORIZACOES), where("codigo", "==", codigo));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { _fbId: d.id, ...d.data() };
  } catch (e) {
    console.error("fbGetAutorizacaoPorCodigo:", e);
    return null;
  }
}

/* Expõe instâncias para uso direto no HTML se necessário */
export { auth, db };
