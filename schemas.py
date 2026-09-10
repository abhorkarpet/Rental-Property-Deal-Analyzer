"""Validated request payloads for API routes."""

from pydantic import BaseModel, Field


class NeighborhoodSearchRequest(BaseModel):
    location: str = Field(min_length=1, max_length=200)
    min_price: float | None = Field(default=None, ge=0)
    max_price: float | None = Field(default=None, ge=0)
    min_beds: int = Field(default=0, ge=0, le=20)
    property_type: str | None = Field(default=None, max_length=50)
    max_results: int = Field(default=25, ge=1, le=75)
    allow_overage: bool = False


class SmartSearchRequest(BaseModel):
    max_price: float | None = Field(default=None, ge=0)
    location: str = Field(min_length=1, max_length=200)
    min_price: float | None = Field(default=None, ge=0)
    min_beds: int = Field(default=0, ge=0, le=20)
    property_type: str | None = Field(default=None, max_length=50)
    max_results: int = Field(default=50, ge=1, le=75)
    allow_overage: bool = False


class BatchImportRequest(BaseModel):
    csv_text: str | None = Field(default=None, max_length=10_500_000)
    sheet_url: str | None = Field(default=None, max_length=500)
    augment_brochures: bool = False


class BatchAugmentRequest(BaseModel):
    deals: list[dict] = Field(default_factory=list, max_length=200)


class BatchEnrichRequest(BaseModel):
    mortgage_rate_pct: float | None = Field(default=None, ge=0, le=30)
    deals: list[dict] = Field(default_factory=list, max_length=200)
    allow_overage: bool = False


class HUDPropertyRequest(BaseModel):
    address: str = Field(default='', max_length=300)
    beds: int | None = Field(default=None, ge=0, le=10)
    entity_id: str | None = Field(default=None, max_length=30)
    zip_code: str | None = Field(default=None, pattern=r'^\d{5}$')


class HUDBenchmarkRequest(BaseModel):
    properties: list[HUDPropertyRequest] = Field(min_length=1, max_length=75)
    year: int | None = Field(default=None, ge=2017, le=2100)
