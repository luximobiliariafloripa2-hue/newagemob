// src/services/events/EventServerEnrichment.js
// Carimba nos eventos já normalizados os campos do contexto de execução do
// servidor — recebidos como um único objeto de contexto, não parâmetros
// soltos. contextoEvento é um contexto evolutivo por design: campos
// futuros (requestId, traceId, ambiente, versaoBackend, hashManifesto,
// certificado, carimboDoTempo, chainId etc.) poderão ser incorporados a
// ele sem exigir nenhuma mudança na assinatura desta função.
//
// O identificador definitivo do evento será definido juntamente com a
// Cadeia de Custódia Oficial (Marco 6), podendo participar do hash, do
// Manifesto, do Merkle Root ou de outro mecanismo oficial. Nenhum formato
// de ID deve ser cristalizado antes desse Marco.
//
// Responsabilidade única e exclusiva deste módulo: produzir uma coleção de
// eventos enriquecidos, em memória. Nunca grava arquivo, nunca grava
// banco, nunca altera Timeline, Custódia, Manifesto ou Hashes, nunca
// realiza qualquer forma de persistência — isso pertence à Microetapa
// 5.5.3 e sprints seguintes.
//
// Não captura `dataHoraServidor` internamente: cada requisição possui
// apenas um único instante oficial do servidor (relógio oficial da
// requisição), capturado uma única vez por quem chama e propagado dentro
// do contexto — nunca recalculado aqui, para que todos os eventos da
// mesma submissão compartilhem exatamente o mesmo timestamp.
//
// Pura: sem efeito colateral algum.

function enriquecerEventosComServidor(eventosNormalizados, contextoEvento) {
  return eventosNormalizados.map((evento) => ({
    tipo:            evento.tipo,
    categoria:       evento.categoria,
    origem:          evento.origem,
    valor:           evento.valor,
    detalhe:         evento.detalhe,
    dataHoraCliente: evento.dataHoraCliente,
    sessao:          evento.sessao,
    ...contextoEvento
  }));
}

module.exports = { enriquecerEventosComServidor };
