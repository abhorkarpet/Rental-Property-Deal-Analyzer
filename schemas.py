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
