import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { documentCategories, type DocumentCategory } from '../../../database/schema/health-documents';

export class ListHealthDocumentsQuery {
  @IsOptional()
  @IsEnum(documentCategories)
  category?: DocumentCategory;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
