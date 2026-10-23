import { getFips, setFips } from 'node:crypto';

export interface CryptoModuleStatus { provider:'openssl'; version:string; fips:boolean }

export function configureCryptoModule(requireFips = process.env.SULLA_FILES_SYNC_REQUIRE_FIPS === 'true'):CryptoModuleStatus {
  if (process.env.OPENSSL_CONF && getFips() !== 1) {
    try { setFips(true) } catch { /* fail closed below only when required */ }
  }
  const status:CryptoModuleStatus={provider:'openssl',version:process.versions.openssl,fips:getFips()===1};
  if(requireFips&&!status.fips)throw Object.assign(new Error('Files cloud sync requires the configured OpenSSL FIPS provider'),{code:'FILES_SYNC_FIPS_REQUIRED'});
  return status;
}
