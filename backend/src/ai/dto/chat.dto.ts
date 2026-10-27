import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

/** Screen content the user chose to send (assistente flutuante). The text is masked and never stored. */
export class ScreenContextDto {
  @IsString() @MaxLength(200) titulo!: string;
  @IsString() @MaxLength(300) rota!: string;
  @IsString() @MaxLength(30000) texto!: string;
}

export class ChatDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(16000)
  message!: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsOptional() @IsUUID()
  modelId?: string;

  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(5) @IsUUID('all', { each: true })
  attachmentIds?: string[];

  @IsOptional() @ValidateNested() @Type(() => ScreenContextDto)
  screenContext?: ScreenContextDto;

  @IsOptional() @IsIn(['assistente'])
  channel?: 'assistente';
}
