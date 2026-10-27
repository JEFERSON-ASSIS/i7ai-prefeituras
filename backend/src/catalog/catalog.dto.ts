import { IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class LicenseDto {
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED', 'EXPIRED']) status?: string;
  @IsOptional() @IsISO8601() startDate?: string;
  @IsOptional() @IsISO8601() endDate?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(1000000) maxUsers?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000000) maxAgents?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000000) maxAutomations?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000000) maxKnowledgeBases?: number;
  @IsOptional() @IsString() @MaxLength(20) maxStorageBytes?: string;
  @IsOptional() @IsString() @MaxLength(20) maxTokens?: string;
  @IsOptional() @IsObject() features?: Record<string, boolean>;
}
