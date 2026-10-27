import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export class OpenConversationDto {
  @IsString({ message: 'Informe o motivo da abertura (10 a 300 caracteres).' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(10, 300, { message: 'Informe o motivo da abertura (10 a 300 caracteres).' })
  motivo!: string;
}
