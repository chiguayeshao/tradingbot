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
  Connection,
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

    // 准备手续费交易
    const connection = new Connection(
      'https://mainnet.helius-rpc.com/?api-key=8df1f178-f82a-4bb5-b363-fb1524351fab',
    );
    const feeAmount = Math.floor(lamports / 100);

    const feeInstruction = SystemProgram.transfer({
      fromPubkey: new PublicKey(wallet.address),
      toPubkey: new PublicKey(this.configService.get('FEE_RECIPIENT_ADDRESS')),
      lamports: feeAmount,
    });

    const feeTx = new Transaction();
    const { blockhash } = await connection.getLatestBlockhash();
    feeTx.recentBlockhash = blockhash;
    feeTx.feePayer = new PublicKey(wallet.address);
    feeTx.add(feeInstruction);
    feeTx.sign(signer);

    // 准备 swap 交易
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
    const swapTx = Transaction.from(txBuf);
    swapTx.sign(signer);

    // 将两笔交易打包发送
    const transactions = [feeTx.serialize(), swapTx.serialize()];

    const result = await this.jitoService.sendBundle(transactions);

    return {
      transaction: swapTx,
      referralBalance: Math.floor(feeAmount * 0.25),
      bundleResult: result,
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

      // 准备手续费交易
      const connection = new Connection(
        'https://mainnet.helius-rpc.com/?api-key=8df1f178-f82a-4bb5-b363-fb1524351fab',
      );
      const feeAmount = Math.floor(outAmount / 100);

      const feeInstruction = SystemProgram.transfer({
        fromPubkey: new PublicKey(wallet.address),
        toPubkey: new PublicKey(
          this.configService.get('FEE_RECIPIENT_ADDRESS'),
        ),
        lamports: feeAmount,
      });

      const feeTx = new Transaction();
      const { blockhash } = await connection.getLatestBlockhash();
      feeTx.recentBlockhash = blockhash;
      feeTx.feePayer = new PublicKey(wallet.address);
      feeTx.add(feeInstruction);

      // 使用 Keypair 创建 signer
      const privateKey = bs58.decode(wallet.private_key);
      const keypair = Keypair.fromSecretKey(privateKey);
      const signer: Signer = {
        publicKey: keypair.publicKey,
        secretKey: keypair.secretKey,
      };

      // 签名两笔交易
      feeTx.sign(signer);
      transaction.sign(signer);

      // 将两笔交易打包发送
      const transactions = [
        transaction.serialize(), // 先执行 swap
        feeTx.serialize(), // 再执行手续费转账
      ];

      const result = await this.jitoService.sendBundle(transactions);

      return {
        transaction: transaction,
        referralBalance: Math.floor((totalAmount / 100) * 0.25),
        bundleResult: result,
      };
    } catch (error) {
      console.error('获取卖出指令失败:', error);
      throw error;
    }
  }

  async trade(userId: number, rateOrSol: number, mint: string, isBuy: boolean) {
    try {
      let res: {
        transaction: Transaction;
        referralBalance: number;
        bundleResult: any;
      };
      if (isBuy) {
        res = await this.getBuyInstructions(userId, rateOrSol, mint);
      } else {
        res = await this.getSellInstructions(userId, rateOrSol, mint);
      }

      // 检查 bundle 结果
      if (!res.bundleResult || res.bundleResult.error) {
        throw new Error('Bundle 发送失败');
      }

      console.log('Bundle 发送成功:', res.bundleResult);

      // 延时 2 秒后再查询 bundle 状态
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // 获取 bundle 状态
      const bundleStatus = await this.jitoService.getBundleStatus(
        res.bundleResult.result,
      );
      console.log(bundleStatus, 'bundleStatus');

      // 检查 bundle 状态
      if (
        !bundleStatus.result.value ||
        bundleStatus.result.value.length === 0
      ) {
        throw new Error('交易未上链');
      }

      const transactions = bundleStatus.result.value[0].transactions;
      const feeTransactionSignature = transactions[1]; // 获取手续费交易的签名

      // 添加到队列进行确认检查
      this.resultQueue.add(
        'checkTx',
        {
          txid: feeTransactionSignature,
          userId,
          referralBalance: res.referralBalance,
        },
        {
          delay: 2000,
          backoff: {
            type: 'fixed',
            delay: 2000,
          },
        },
      );

      return res.bundleResult.result;
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
