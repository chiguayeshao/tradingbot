import { Injectable } from '@nestjs/common';
import { PumpFunService } from './pump-fun/pump-fun.service';
import { ResponseDto } from './jupiter-price-response-dto/response.dto';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { TokenInfo } from './token-info.entity';
import { TokenInfoDto } from './token-info.dto';
import { Repository } from 'typeorm';
import { PumpFunResponseDto } from './pump-fun/pump-fun-response.dto';
import { RedisCacheService } from '../redis-cache/redis-cache.service';

@Injectable()
export class TokenInfoService {
  constructor(
    private readonly pumpFunService: PumpFunService,
    private readonly configService: ConfigService,
    @InjectRepository(TokenInfo)
    private readonly tokenInfoRepository: Repository<TokenInfo>,
    private readonly redisCacheService: RedisCacheService,
  ) {}

  async getFullTokenInfo(mint: string) {
    try {
      const tokenInfo = this.getTokenInfo(mint);
      const tokenPrice = this.getTokenPrice(mint);
      const isPump = this.pumpFunService.isPump(mint);

      const [tokenInfoData, tokenPriceData, isPumpData] = await Promise.all([
        tokenInfo,
        tokenPrice,
        isPump,
      ]);

      if (!tokenPriceData?.data?.[mint]?.price) {
        console.error('获取代币价格失败:', mint);
        throw new Error('获取代币价格失败');
      }

      return {
        ...tokenInfoData,
        price: tokenPriceData.data[mint].price,
        isPump: isPumpData,
      };
    } catch (error) {
      console.error('获取代币信息失败:', error);
      throw error;
    }
  }

  async getPumpInfo(mint: string): Promise<PumpFunResponseDto> {
    return await this.pumpFunService.getPumpInfo(mint);
  }

  async getTokenPrice(mint: string): Promise<ResponseDto> {
    try {
      const cacheKey = `token_price_${mint}`;
      const cachedData =
        await this.redisCacheService.get<ResponseDto>(cacheKey);
      if (cachedData) {
        return cachedData;
      }

      console.log('正在获取代币价格:', mint);
      const response = await fetch(
        `https://api.jup.ag/price/v2?ids=${mint}&showExtraInfo=true`,
      );

      console.log('Jupiter API 响应状态:', response.status);
      if (response.status === 200) {
        const data: ResponseDto = await response.json();
        await this.redisCacheService.set(cacheKey, data);
        return data;
      } else {
        const errorText = await response.text();
        console.error('Jupiter API 错误响应:', errorText);
        throw new Error(`Jupiter API 错误: ${response.status}`);
      }
    } catch (error) {
      console.error('获取代币价格失败:', error);
      throw error;
    }
  }

  async getTokenInfo(mint: string) {
    const tokenInfo = await this.tokenInfoRepository.findOneBy({ mint });
    if (tokenInfo) {
      return tokenInfo;
    }
    const response = await fetch(
      `https://api.shyft.to/sol/v1/token/get_info?network=mainnet-beta&token_address=${mint}`,
      { headers: { 'x-api-key': this.configService.get('SHYFT_API_KEY') } },
    );
    if (response.status === 200) {
      const data: TokenInfoDto = await response.json();
      const newTokenData = {
        mint: data.result.address,
        name: data.result.name,
        symbol: data.result.symbol,
        supply: data.result.current_supply,
        decimals: data.result.decimals,
      };
      const newTokenInfo = this.tokenInfoRepository.create(newTokenData);
      return this.tokenInfoRepository.save(newTokenInfo);
    }
    throw new Error('shyft api error');
  }
}
