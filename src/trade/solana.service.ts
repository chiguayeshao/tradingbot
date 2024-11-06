import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  getAccount,
  getAssociatedTokenAddress,
  getMint,
} from '@solana/spl-token';

@Injectable()
export class SolanaService {
  get connection(): Connection {
    return this._connection;
  }

  constructor(private readonly configService: ConfigService) {}

  private _connection = new Connection(
    this.configService.get('SOLANA_ENDPOINT'),
  );

  async getTokenFmtBalance(address: string, mintStr: string) {
    try {
      const wallet = new PublicKey(address);
      const mintKey = new PublicKey(mintStr);
      const tokenAccount = await getAssociatedTokenAddress(mintKey, wallet);

      // 先检查账户是否存在
      const accountInfo = await this.connection.getAccountInfo(tokenAccount);
      if (!accountInfo) {
        return 0; // 如果账户不存在，返回0余额
      }

      const info = await getAccount(this.connection, tokenAccount);
      const mint = await getMint(this.connection, info.mint);
      return Number(info.amount) / 10 ** mint.decimals;
    } catch (error) {
      console.log(`获取代币余额失败: ${error.message}`);
      return 0; // 发生错误时返回0
    }
  }

  async getTokenBalance(address: string, mintStr: string) {
    try {
      const wallet = new PublicKey(address);
      const mintKey = new PublicKey(mintStr);
      const tokenAccount = await getAssociatedTokenAddress(mintKey, wallet);

      // 先检查账户是否存在
      const accountInfo = await this.connection.getAccountInfo(tokenAccount);
      if (!accountInfo) {
        return 0;
      }

      const info = await getAccount(this.connection, tokenAccount);
      return Number(info.amount);
    } catch (error) {
      console.log(`获取代币余额失败: ${error.message}`);
      return 0;
    }
  }
}
