"""Generates tests/fixtures/sample.pdf, the fixture used by the pdf-to-docx tests.

Run:  py tests/fixtures/make_sample_pdf.py     (needs reportlab + Pillow)

It deliberately covers the cases the converter has to get right:
  * a numbered, bold heading ("1. Overview") directly followed by body text
    with no blank line (ambiguous with a numbered list item)
  * a real numbered list in body-size, non-bold text
  * bullet lists, a callout, a table, a monospace code block, an image
  * a header and "Page N of M" footer repeated on every page
"""

import os

from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
PDF_PATH = os.path.join(HERE, "sample.pdf")
IMG_PATH = os.path.join(HERE, "sample_image.png")

PAGES = 3
LEFT = 72


def make_image():
    img = Image.new("RGB", (400, 250), (70, 130, 180))
    draw = ImageDraw.Draw(img)
    draw.rectangle([20, 20, 380, 230], outline=(255, 255, 255), width=5)
    draw.text((140, 115), "SAMPLE SCREENSHOT", fill=(255, 255, 255))
    img.save(IMG_PATH)


def main():
    make_image()
    c = canvas.Canvas(PDF_PATH, pagesize=letter)
    width, height = letter

    def frame(page_no):
        c.setFont("Helvetica", 8)
        c.setFillGray(0.45)
        c.drawString(LEFT, height - 40, "Acme Deployment Guide - Confidential")
        c.drawCentredString(width / 2, 36, f"Page {page_no} of {PAGES}")
        c.setFillGray(0)

    def text(y, s, font="Helvetica", size=11, x=LEFT):
        c.setFont(font, size)
        c.drawString(x, y, s)

    # ---------------- page 1 ----------------
    frame(1)
    y = height - 90
    text(y, "Acme Deployment Guide", "Helvetica-Bold", 24)
    y -= 34
    text(y, "This guide explains how to deploy the Acme service to a new server.")
    y -= 14
    text(y, "It is written for engineers who have shell access to the target host.")
    y -= 38
    text(y, "1. Overview", "Helvetica-Bold", 16)
    y -= 15  # tight: no blank line between heading and paragraph
    text(y, "The service has two parts: an API process and a background worker.")
    y -= 14
    text(y, "Both are configured through a single environment file.")
    y -= 34
    text(y, "Prerequisites", "Helvetica-Bold", 13)
    y -= 22
    for item in ("- A Linux server with 2 GB of RAM", "- Docker 24 or newer", "- A DNS record for the service"):
        text(y, item)
        y -= 15
    y -= 20
    for i, item in enumerate(("Create the deploy user", "Copy the environment file", "Open port 8080"), 1):
        text(y, f"{i}. {item}")
        y -= 15
    y -= 20
    text(y, "WARNING: Never commit the environment file to version control.")

    c.showPage()

    # ---------------- page 2 ----------------
    frame(2)
    y = height - 90
    text(y, "2. Installation", "Helvetica-Bold", 16)
    y -= 34
    text(y, "Run the installer from the project root:")
    y -= 24
    for line in ("docker compose pull", "docker compose up -d", "    --scale worker=2"):
        text(y, line, "Courier", 10, x=LEFT + 18)
        y -= 13
    y -= 26
    text(y, "Supported environments", "Helvetica-Bold", 13)
    y -= 26
    cols = (LEFT, LEFT + 150, LEFT + 290)
    for row_no, row in enumerate((("Name", "Memory", "Region"), ("small", "2 GB", "eu-west"), ("medium", "8 GB", "us-east"), ("large", "32 GB", "ap-south"))):
        for x, cell in zip(cols, row):
            text(y, cell, "Helvetica-Bold" if row_no == 0 else "Helvetica", 11, x=x)
        y -= 17
    y -= 22
    for i, item in enumerate(("Verify the containers are healthy", "Check the logs for errors"), 1):
        text(y, f"{i}. {item}")
        y -= 15

    c.showPage()

    # ---------------- page 3 ----------------
    frame(3)
    y = height - 90
    text(y, "3. Screenshots", "Helvetica-Bold", 16)
    y -= 34
    text(y, "The dashboard should look like this after a successful deploy:")
    y -= 28
    c.drawImage(IMG_PATH, LEFT, y - 187, width=300, height=187.5)
    y -= 187 + 34
    text(y, "SCREENSHOT REQUIRED: capture the final state of the dashboard.")
    y -= 36
    text(y, "That completes the deployment.")

    c.showPage()
    c.save()
    print(PDF_PATH)


if __name__ == "__main__":
    main()
