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
    mainnet: 'https://mainnet.block-engine.jito.wtf',
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
    const res = await fetch(`${endpoint}/api/v1/transactions?bundleOnly=true`, {
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

  async sendBundle(transactions: (Uint8Array | Buffer | number[])[]) {
    const endpoint = this.getRandomJitoEndpoint();
    const encodedTxs = transactions.map((tx) => bs58.encode(tx));
    console.log(encodedTxs, 'encodedTxs');

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [encodedTxs],
    };

    const res = await fetch(`${endpoint}/api/v1/bundles`, {
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

  async getBundleStatus(bundleId: string) {
    const endpoint = this.getRandomJitoEndpoint();
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBundleStatuses',
      params: [[bundleId]],
    };

    const res = await fetch(`${endpoint}/api/v1/bundles`, {
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
