import { UserStatus } from '@prisma/client';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsISO8601, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class DepartmentDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: string;
}
export class UpdateDepartmentDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: string;
}
export class CreateUserDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsOptional() @IsUUID() departmentId?: string | null;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(20) @IsUUID('all', { each: true }) roleIds?: string[];
}
export class UpdateUserDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160) name?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsUUID() departmentId?: string | null;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(20) @IsUUID('all', { each: true }) roleIds?: string[];
}
export class SettingsDto {
  @IsOptional() @IsString() @MaxLength(160) organizationName?: string;
  @IsOptional() @IsString() @MaxLength(80) timezone?: string;
  @IsOptional() @IsString() @MaxLength(20) locale?: string;
  @IsOptional() @IsUUID() defaultModelId?: string | null;
  @IsOptional() @IsIn(['light', 'dark', 'system']) theme?: string;
  @IsOptional() @IsInt() @Min(1) @Max(3650) retentionDays?: number | null;
  @IsOptional() @IsBoolean() allowSignups?: boolean;
}
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
