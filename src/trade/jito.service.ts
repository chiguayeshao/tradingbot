import { Injectable } from '@nestjs/common';
import bs58 from 'bs58';

@Injectable()
export class JitoService {
  get JitoEndpoints(): {
    mainnet: string;
  } {
    return this._JitoEndpoints;
  }

  private _JitoEndpoints = {
    mainnet: 'https://mainnet.block-engine.jito.wtf/api/v1/transactions',
  };

  getRandomJitoEndpoint() {
    return this._JitoEndpoints.mainnet;
  }

  async sendWithJito(serializedTx: Uint8Array | Buffer | number[]) {
    const endpoint = this.getRandomJitoEndpoint();
    const encodedTx = bs58.encode(serializedTx);
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [encodedTx],
    };
    const res = await fetch(`${endpoint}?bundleOnly=true`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    if (json.error) {
      throw new Error(json.error.message);
    }
    return json;
  }
}
