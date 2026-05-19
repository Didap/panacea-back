import { IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { documentCategories, type DocumentCategory } from '../../../database/schema/health-documents';

export class UploadHealthDocumentDto {
  @IsString()
  @MaxLength(255)
  title!: string;

  @IsEnum(documentCategories)
  category!: DocumentCategory;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsDateString()
  takenAt?: string;
}
