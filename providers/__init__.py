"""Data providers for the deal analyzer.

Each module here owns one source of property data. Endpoints in app.py call
these; they should never need to know about a scraper's URL format or an
API's request shape.
"""
