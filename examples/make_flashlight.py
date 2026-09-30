#!/usr/bin/env python3
"""Draws examples/flashlight.pdf: an unlabeled two-figure sample drawing (a flashlight
and its exploded view) to try the labeler on. Needs reportlab."""
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter


def knurl(c, x0, n, y0, y1, step=6):
    for i in range(n):
        c.line(x0 + i * step, y0, x0 + i * step, y1)


def head(c, x):
    p = c.beginPath()
    p.moveTo(x, -15); p.lineTo(x + 40, -30); p.lineTo(x + 40, 30); p.lineTo(x, 15); p.close()
    c.drawPath(p)


c = canvas.Canvas("flashlight.pdf", pagesize=letter)
c.setTitle("Flashlight (sample drawing)")
c.setLineWidth(1.1)

# FIG. 1: assembled, side view
c.saveState(); c.translate(150, 560); c.scale(1.25, 1.25)
c.rect(0, -18, 26, 36); knurl(c, 5, 4, -18, 18)             # tail cap
c.rect(26, -15, 170, 30); knurl(c, 60, 10, -15, 15)         # barrel with grip
head(c, 196)                                                  # head
c.rect(236, -32, 10, 64)                                      # bezel
c.ellipse(240, -26, 252, 26)                                  # lens
c.roundRect(120, 15, 30, 8, 3)                                # switch
c.line(40, 15, 40, 26); c.line(40, 26, 150, 26); c.line(150, 26, 160, 19)   # pocket clip
c.restoreState()

# FIG. 2: exploded view
c.saveState(); c.translate(75, 300); c.scale(0.9, 0.9)
c.rect(0, -18, 26, 36); knurl(c, 5, 4, -18, 18)             # tail cap
for i in range(6):                                            # spring
    c.line(32 + i * 5, -10, 35 + i * 5, 10); c.line(35 + i * 5, 10, 37 + i * 5, -10)
c.roundRect(75, -11, 70, 22, 5); c.rect(145, -4, 5, 8)       # battery
c.roundRect(158, -11, 70, 22, 5); c.rect(228, -4, 5, 8)      # battery
c.rect(250, -15, 170, 30); knurl(c, 284, 10, -15, 15)       # barrel
c.roundRect(344, 15, 30, 8, 3)                                # switch
head(c, 440); c.circle(462, 0, 7)                             # head and bulb
c.ellipse(500, -26, 512, 26)                                  # lens
c.rect(520, -32, 10, 64)                                      # bezel
c.restoreState()

c.showPage(); c.save()
