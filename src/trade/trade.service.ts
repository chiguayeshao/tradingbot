import { Injectable } from '@nestjs/common';
import { createJupiterApiClient, QuoteResponse } from '@jup-ag/api';
import { SettingService } from '../setting/setting.service';
import {
  Keypair,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { ConfigService } from '@nestjs/config';
import bs58 from 'bs58';
import { SolanaService } from './solana.service';
import { JitoService } from './jito.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Trade } from './trade.entity';
import { Repository } from 'typeorm';
import { UserService } from '../user/user.service';
import * as _ from 'lodash';

@Injectable()
export class TradeService {
  get NativeSol(): string {
    return this._NativeSol;
  }

  set NativeSol(value: string) {
    this._NativeSol = value;
  }

  private jupiterQuoteApi = createJupiterApiClient();
  private _NativeSol = 'So11111111111111111111111111111111111111112';

  constructor(
    private readonly settingService: SettingService,
    private readonly configService: ConfigService,
    private readonly solanaService: SolanaService,
    private readonly jitoService: JitoService,
    private readonly userService: UserService,
    @InjectRepository(Trade)
    private readonly tradeRepository: Repository<Trade>,
    @InjectQueue('trade_result') private readonly resultQueue: Queue,
  ) {}

  getFeeInstructions(
    address: string,
    feeAmount: number,
  ): TransactionInstruction[] {
    const feeReceiverAddress = this.configService.get('FEE_RECIPIENT_ADDRESS');
    // Create a solana transfer instruction with web3.js
    const instruction = SystemProgram.transfer({
      fromPubkey: new PublicKey(address),
      toPubkey: new PublicKey(feeReceiverAddress),
      lamports: feeAmount,
    });
    return [instruction];
  }

  async createTrade(
    userId: number,
    amount: number,
    solAmount: number,
    mint: string,
    isBuy: boolean,
  ) {
    const price = solAmount / amount;
    const trade = this.tradeRepository.create({
      user: { id: userId },
      amount,
      solAmount,
      tokenMint: mint,
      price,
      is_buy: isBuy,
    });
    await this.tradeRepository.save(trade);
    return trade;
  }

  async confirmTrade(txid: string) {
    const trade = await this.tradeRepository.findOneBy({ txid });
    if (trade) {
      trade.confirmed = true;
      await this.tradeRepository.save(trade);
    }
  }

  async getSwapTx(
    userId: number,
    quoteResponse: QuoteResponse,
    walletAddress: string,
  ) {
    try {
      const jitoFee = await this.settingService.getJitoFee(userId);
      const response = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteResponse,
          asLegacyTransaction: true,
          prioritizationFeeLamports: {
            jitoTipLamports: jitoFee,
          },
          dynamicComputeUnitLimit: true,
          userPublicKey: walletAddress,
          wrapAndUnwrapSol: true,
          skipUserAccountsRpcCalls: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Jupiter Swap API 错误:', errorText);
        throw new Error('获取交易指令失败');
      }

      const { swapTransaction } = await response.json();
      return swapTransaction;
    } catch (error) {
      console.error('获取交易指令失败:', error);
      throw error;
    }
  }

  async getBuyInstructions(userId: number, amount: number, mint: string) {
    const wallet = await this.settingService.getWallet(userId);
    const privateKey = wallet.private_key;
    const signWallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    const signer: Signer = {
      publicKey: signWallet.publicKey,
      secretKey: signWallet.secretKey,
    };
    const slippage = await this.settingService.getSlippage(userId);
    const lamports = Math.floor(amount * 10 ** 9);
    const quote = await this.jupiterQuoteApi.quoteGet({
      inputMint: this.NativeSol,
      outputMint: mint,
      amount: lamports,
      slippageBps: slippage * 100,
    });
    await this.createTrade(
      userId,
      Number(quote.outAmount),
      Number(quote.inAmount),
      mint,
      true,
    );
    const swapTransaction = await this.getSwapTx(userId, quote, wallet.address);
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = Transaction.from(txBuf);
    const feeInstruction = this.getFeeInstructions(
      wallet.address,
      Math.floor(lamports / 100),
    );
    transaction.add(...feeInstruction);
    transaction.sign(signer);
    return {
      transaction,
      referralBalance: Math.floor((lamports / 100) * 0.25),
    };
  }

  async getSellInstructions(userId: number, rate: number, mint: string) {
    try {
      const wallet = await this.settingService.getWallet(userId);
      const totalAmount = await this.solanaService.getTokenBalance(
        wallet.address,
        mint,
      );

      // 检查余额
      if (totalAmount <= 0) {
        throw new Error('代币余额不足');
      }

      const amount = Math.floor((totalAmount * rate) / 100);
      // 检查计算后的数量
      if (amount <= 0) {
        throw new Error('交易数量太小');
      }

      console.log('交易数量:', amount);

      const slippage = await this.settingService.getSlippage(userId);
      const quote = await this.jupiterQuoteApi.quoteGet({
        inputMint: mint,
        outputMint: this.NativeSol,
        amount: amount,
        slippageBps: slippage * 100,
      });

      const outAmount = parseInt(quote.outAmount);
      const swapTransaction = await this.getSwapTx(
        userId,
        quote,
        wallet.address,
      );

      await this.createTrade(userId, amount, outAmount, mint, false);
      const txBuf = Buffer.from(swapTransaction, 'base64');
      const transaction = Transaction.from(txBuf);

      const feeInstruction = this.getFeeInstructions(
        wallet.address,
        Math.floor(outAmount / 100),
      );
      transaction.add(...feeInstruction);

      // 使用 Keypair 创建 signer
      const privateKey = bs58.decode(wallet.private_key);
      const keypair = Keypair.fromSecretKey(privateKey);
      const signer: Signer = {
        publicKey: keypair.publicKey,
        secretKey: keypair.secretKey,
      };

      transaction.sign(signer);
      return {
        transaction,
        referralBalance: Math.floor((totalAmount / 100) * 0.25),
      };
    } catch (error) {
      console.error('获取卖出指令失败:', error);
      throw error;
    }
  }

  async trade(userId: number, rateOrSol: number, mint: string, isBuy: boolean) {
    try {
      let res: { transaction: Transaction; referralBalance: number };
      if (isBuy) {
        res = await this.getBuyInstructions(userId, rateOrSol, mint);
      } else {
        res = await this.getSellInstructions(userId, rateOrSol, mint);
      }
      const serializedTx = res.transaction.serialize();
      const result = await this.jitoService.sendWithJito(serializedTx);
      console.log(result, 'result');
      // 添加交易结果检查
      if (!result || !result.result) {
        throw new Error('交易发送失败');
      }

      console.log(`交易已发送: ${result.result}`);

      // 交易确认后再添加到队列
      this.resultQueue.add(
        'checkTx',
        { txid: result.result, userId, referralBalance: res.referralBalance },
        {
          delay: 2000,
          backoff: {
            type: 'fixed',
            delay: 2000,
          },
        },
      );

      return result.result;
    } catch (error) {
      console.error('交易执行失败:', error);
      throw new Error(`交易执行失败: ${error.message}`);
    }
  }

  async getQuotePrice(mint: string, amount: number) {
    const quote = await this.jupiterQuoteApi.quoteGet({
      inputMint: mint,
      outputMint: this.NativeSol,
      amount: amount,
    });
    return quote.outAmount;
  }

  async calculateProfit(userId: number, mint: string) {
    const trades = await this.tradeRepository.find({
      where: { tokenMint: mint, user: { id: userId } },
    });
    const buyTrades = _.filter(trades, { is_buy: true });
    const solOut = _.sumBy(buyTrades, 'solAmount');
    const sellTrades = _.filter(trades, { is_buy: false });
    const solIn = _.sumBy(sellTrades, 'solAmount');
    const wallet = await this.settingService.getWallet(userId);
    const currentPositionInToken = await this.solanaService.getTokenBalance(
      wallet.address,
      mint,
    );
    let currentPositionInSol = 0;
    if (currentPositionInToken > 0) {
      currentPositionInSol = Number(
        await this.getQuotePrice(mint, currentPositionInToken),
      );
    }
    const profit: number = solIn - solOut + Number(currentPositionInSol);
    return Number(profit.toFixed(2));
  }
}
