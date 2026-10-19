import { createRequire } from 'module';
import type { ConfiguracionTienda } from '@prisma/client';

const require = createRequire(import.meta.url);
const Afip = require('@afipsdk/afip.js');

export type TipoFactura = 'A' | 'B' | 'C';

export type ResultadoFactura = {
  cae: string;
  vencimientoCae: string;
  numeroFactura: number;
  tipoFactura: TipoFactura;
};

// shortcut: un singleton por proceso; se recrea si cambia CUIT o entorno
let _instance: any = null;
let _cuit: string | null = null;
let _prod: boolean | null = null;

function getInstance(config: ConfiguracionTienda) {
  if (_instance && _cuit === config.cuit && _prod === config.entornoProduccion) {
    return _instance;
  }
  const opts: Record<string, any> = {
    CUIT: parseInt(config.cuit),
    production: config.entornoProduccion,
  };
  // En producción, el cert y key se leen de env vars (contenido PEM, no rutas)
  if (config.entornoProduccion) {
    if (process.env.AFIP_CERT) opts.cert = process.env.AFIP_CERT;
    if (process.env.AFIP_KEY)  opts.key  = process.env.AFIP_KEY;
  }
  _instance = new Afip(opts);
  _cuit = config.cuit;
  _prod = config.entornoProduccion;
  return _instance;
}

/**
 * Emite una factura electrónica en ARCA/AFIP.
 * En modo sandbox (entornoProduccion=false) no requiere cert/key real.
 */
export async function emitirFactura(
  config: ConfiguracionTienda,
  total: number,
  tipoFactura: TipoFactura,
  compradorCuit?: string,
): Promise<ResultadoFactura> {
  const afip = getInstance(config);
  const isMonotributo = config.condicionFiscal === 'MONOTRIBUTO';

  // CbteTipo: 1=A  6=B  11=C
  const cbteTipo = tipoFactura === 'A' ? 1 : tipoFactura === 'B' ? 6 : 11;

  const lastVoucher = await afip.ElectronicBilling.getLastVoucher(config.puntoVenta, cbteTipo);
  const nextNum: number = lastVoucher + 1;

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // IVA: C/mono → sin IVA; B/A de RI → 21%
  let impNeto: number;
  let impIVA: number;
  let iva: object[] | undefined;

  if (isMonotributo || tipoFactura === 'C') {
    impNeto = total;
    impIVA  = 0;
    iva     = undefined;
  } else {
    impNeto = parseFloat((total / 1.21).toFixed(2));
    impIVA  = parseFloat((total - impNeto).toFixed(2));
    iva     = [{ Id: 5, BaseImp: impNeto, Importe: impIVA }]; // 21%
  }

  const data: Record<string, any> = {
    CantReg   : 1,
    PtoVta    : config.puntoVenta,
    CbteTipo  : cbteTipo,
    Concepto  : 1,                             // Productos
    DocTipo   : compradorCuit ? 80 : 99,       // 80=CUIT  99=Consumidor final
    DocNro    : compradorCuit
                  ? parseInt(compradorCuit.replace(/[-\s]/g, ''))
                  : 0,
    CbteDesde : nextNum,
    CbteHasta : nextNum,
    CbteFch   : parseInt(today),
    ImpTotal  : total,
    ImpTotConc: 0,
    ImpNeto   : impNeto,
    ImpOpEx   : 0,
    ImpIVA    : impIVA,
    ImpTrib   : 0,
    MonId     : 'PES',
    MonCotiz  : 1,
  };

  if (iva) data.Iva = iva;

  const result = await afip.ElectronicBilling.createVoucher(data);

  return {
    cae           : result.CAE,
    vencimientoCae: result.CAEFchVto,
    numeroFactura : nextNum,
    tipoFactura,
  };
}
