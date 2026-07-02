// Validação de CPF
function validarCPF(cpf) {
  const c = cpf.replace(/\D/g,'');
  if (c.length !== 11 || /^(\d)+$/.test(c)) return false;
  let s = 0; for(let i=0;i<9;i++) s += +c[i]*(10-i);
  let r = s%11<2?0:11-s%11; if(r!==+c[9]) return false;
  s=0; for(let i=0;i<10;i++) s+=+c[i]*(11-i);
  r=s%11<2?0:11-s%11; return r===+c[10];
}
function validarCNPJ(cnpj) {
  const c = cnpj.replace(/\D/g,'');
  if (c.length !== 14 || /^(\d)+$/.test(c)) return false;
  const calc = (c, n) => { let s=0,p=n-7; for(let i=0;i<n-1;i++){s+=+c[i]*(p--); if(p<2)p=9;} const r=s%11; return r<2?0:11-r; };
  return calc(c,10)===+c[9] && calc(c,11)===+c[10];
}

module.exports = { validarCPF, validarCNPJ };
