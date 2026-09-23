import os
import math
import urllib.request
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# Output path
OUTPUT_PATH = "assets/dmg-background.png"
FONT_DIR = "/tmp/cinderdeck-fonts"

# Fontsource via jsDelivr CDN
FONT_BOLD_URL = "https://cdn.jsdelivr.net/fontsource/fonts/plus-jakarta-sans@latest/latin-700-normal.ttf"
FONT_MEDIUM_URL = "https://cdn.jsdelivr.net/fontsource/fonts/plus-jakarta-sans@latest/latin-500-normal.ttf"

def download_fonts():
    os.makedirs(FONT_DIR, exist_ok=True)
    bold_path = os.path.join(FONT_DIR, "PlusJakartaSans-Bold.ttf")
    medium_path = os.path.join(FONT_DIR, "PlusJakartaSans-Medium.ttf")

    # Download Bold
    if not os.path.exists(bold_path):
        print("Downloading Plus Jakarta Sans Bold from CDN...")
        try:
            urllib.request.urlretrieve(FONT_BOLD_URL, bold_path)
        except Exception as e:
            print(f"Error downloading bold font: {e}")
            bold_path = None
    
    # Download Medium
    if not os.path.exists(medium_path):
        print("Downloading Plus Jakarta Sans Medium from CDN...")
        try:
            urllib.request.urlretrieve(FONT_MEDIUM_URL, medium_path)
        except Exception as e:
            print(f"Error downloading medium font: {e}")
            medium_path = None

    return bold_path, medium_path

def get_fonts(bold_path, medium_path):
    font_title, font_sub, font_desc, font_badge = None, None, None, None
    
    # Try custom fonts first, then try Helvetica (default macOS sans-serif), then fallback to default
    font_options = [
        (bold_path, medium_path),
        ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Helvetica.ttc"),
        ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf")
    ]
    
    for b_path, m_path in font_options:
        try:
            if b_path and os.path.exists(b_path):
                font_title = ImageFont.truetype(b_path, 28)
                font_badge = ImageFont.truetype(b_path, 14)
            if m_path and os.path.exists(m_path):
                font_sub = ImageFont.truetype(m_path, 18)
                font_desc = ImageFont.truetype(m_path, 16)
            if font_title and font_sub:
                print(f"Successfully loaded font: {b_path}")
                break
        except Exception as e:
            print(f"Failed to load font from {b_path}: {e}")
            font_title, font_sub, font_desc, font_badge = None, None, None, None
            
    if not font_title:
        print("Using basic fallback fonts...")
        font_title = ImageFont.load_default()
        font_sub = ImageFont.load_default()
        font_desc = ImageFont.load_default()
        font_badge = ImageFont.load_default()
        
    return font_title, font_sub, font_desc, font_badge

def draw_gradient_background(draw, size):
    width, height = size
    # Premium Light Grey to Off-White gradient
    # Top-Left: #f0f2f8 (light slate-blue tint), Bottom-Right: #fcfdfe
    c1 = (240, 242, 248) # Muted light blue slate
    c2 = (252, 253, 254) # Pure crisp off-white
    
    for y in range(height):
        # Linear interpolation based on diagonal position
        for x in range(width):
            t = (x / width + y / height) / 2.0
            r = int(c1[0] * (1 - t) + c2[0] * t)
            g = int(c1[1] * (1 - t) + c2[1] * t)
            b = int(c1[2] * (1 - t) + c2[2] * t)
            draw.point((x, y), fill=(r, g, b, 255))

def draw_grid(draw, size):
    width, height = size
    grid_size = 40
    # Very subtle developer/canvas grid lines (softened for light theme)
    grid_color = (57, 95, 255, 5)  # ~2% opacity brand blue
    
    for x in range(0, width, grid_size):
        draw.line([(x, 0), (x, height)], fill=grid_color, width=1)
    for y in range(0, height, grid_size):
        draw.line([(0, y), (width, y)], fill=grid_color, width=1)

def draw_bezier_curve(draw, p0, p1, p2, color, width=4, num_points=100):
    # Quadratic Bezier: B(t) = (1-t)^2 * P0 + 2(1-t)t * P1 + t^2 * P2
    points = []
    for i in range(num_points + 1):
        t = i / num_points
        x = (1 - t)**2 * p0[0] + 2 * (1 - t) * t * p1[0] + t**2 * p2[0]
        y = (1 - t)**2 * p0[1] + 2 * (1 - t) * t * p1[1] + t**2 * p2[1]
        points.append((x, y))
        
    for i in range(len(points) - 1):
        draw.line([points[i], points[i+1]], fill=color, width=int(width))
        
    return points

def draw_arrow_head(draw, tip, angle_rad, size=15, color=(57, 95, 255, 255)):
    # Arrow head points
    dx1 = math.cos(angle_rad + 2.5) * size
    dy1 = math.sin(angle_rad + 2.5) * size
    dx2 = math.cos(angle_rad - 2.5) * size
    dy2 = math.sin(angle_rad - 2.5) * size
    
    pt1 = (tip[0] + dx1, tip[1] + dy1)
    pt2 = (tip[0] + dx2, tip[1] + dy2)
    
    draw.polygon([tip, pt1, pt2], fill=color)

def draw_glass_card(img, x_center, y_center, w, h, radius, border_color, bg_color):
    draw = ImageDraw.Draw(img)
    x0, y0 = x_center - w//2, y_center - h//2
    x1, y1 = x_center + w//2, y_center + h//2
    
    # 1. Fill base with transparency
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=bg_color)
    
    # 2. Draw border
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, outline=border_color, width=2)

def draw_glow_effect(img, p0, p1, p2, color, blur_radius=15):
    # Create overlay for glow
    glow_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow_layer)
    
    # Draw thicker path for glow
    pts = []
    num_points = 50
    for i in range(num_points + 1):
        t = i / num_points
        x = (1 - t)**2 * p0[0] + 2 * (1 - t) * t * p1[0] + t**2 * p2[0]
        y = (1 - t)**2 * p0[1] + 2 * (1 - t) * t * p1[1] + t**2 * p2[1]
        pts.append((x, y))
        
    for i in range(len(pts) - 1):
        gd.line([pts[i], pts[i+1]], fill=color, width=12)
        
    # Apply Gaussian Blur
    glow_blurred = glow_layer.filter(ImageFilter.GaussianBlur(blur_radius))
    
    # Blend with main image
    return Image.alpha_composite(img, glow_blurred)

def main():
    print("Redesigning Cinderdeck DMG background image (Light Theme)...")
    
    # Download fonts
    bold_path, medium_path = download_fonts()
    font_title, font_sub, font_desc, font_badge = get_fonts(bold_path, medium_path)
    
    # Setup canvas 1320 x 800
    width, height = 1320, 800
    base_img = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    draw = ImageDraw.Draw(base_img)
    
    # 1. Background and Grid
    draw_gradient_background(draw, (width, height))
    draw_grid(draw, (width, height))
    
    # 2. Screenshot Crop Bounding Box (Marching Ants / Crop Frame style)
    # Bounding box around the core elements: x=140 to 1180, y=140 to 620
    crop_x0, crop_y0 = 140, 160
    crop_x1, crop_y1 = 1180, 620
    crop_color = (57, 95, 255, 90) # Brand blue with 35% opacity
    draw.rectangle([crop_x0, crop_y0, crop_x1, crop_y1], outline=crop_color, width=2)
    
    # Draw crop handles (squares at the corners and midpoints)
    handle_size = 12
    handles = [
        (crop_x0, crop_y0), (crop_x1, crop_y0), (crop_x0, crop_y1), (crop_x1, crop_y1),
        ((crop_x0+crop_x1)//2, crop_y0), ((crop_x0+crop_x1)//2, crop_y1),
        (crop_x0, (crop_y0+crop_y1)//2), (crop_x1, (crop_y0+crop_y1)//2)
    ]
    for hx, hy in handles:
        draw.rectangle(
            [hx - handle_size//2, hy - handle_size//2, hx + handle_size//2, hy + handle_size//2],
            fill=(255, 255, 255, 255),
            outline=(57, 95, 255, 255),
            width=2
        )
        
    # Draw a custom Cinderdeck dimension badge (Focal point: vibrant brand-blue capsule!)
    badge_text = "1320 x 800"
    badge_w, badge_h = 104, 28
    badge_x0, badge_y0 = crop_x0, crop_y0 - badge_h - 10
    draw.rounded_rectangle(
        [badge_x0, badge_y0, badge_x0 + badge_w, badge_y0 + badge_h],
        radius=6,
        fill=(57, 95, 255, 240), # Solid vibrant brand blue
        outline=(57, 95, 255, 255),
        width=1
    )
    # Centered text in badge (pure white)
    draw.text(
        (badge_x0 + badge_w//2, badge_y0 + badge_h//2 - 1),
        badge_text,
        fill=(255, 255, 255, 255),
        font=font_badge,
        anchor="mm"
    )

    # 3. Floating Glassmorphic Annotation Toolbar at the top center (Light version)
    tb_w, tb_h = 440, 68
    tb_cx, tb_cy = 660, 95
    tb_x0, tb_y0 = tb_cx - tb_w//2, tb_cy - tb_h//2
    # Glass background
    draw.rounded_rectangle(
        [tb_x0, tb_y0, tb_x0 + tb_w, tb_y0 + tb_h],
        radius=18,
        fill=(255, 255, 255, 225),  # Semi-transparent pure white
        outline=(57, 95, 255, 30),  # Very light blue outline
        width=2
    )
    
    # Non-active tools color (deep slate for high contrast on white card)
    tool_color = (71, 85, 105, 255) # Slate-600
    
    # Tools positions
    tool_xs = [tb_x0 + 40 + i * 72 for i in range(6)]
    # Tool 1: Arrow Annotation Tool (active tool, highlighted in blue)
    draw.ellipse(
        [tool_xs[1] - 22, tb_cy - 22, tool_xs[1] + 22, tb_cy + 22],
        fill=(57, 95, 255, 255)
    )
    
    # Draw simple vector mockups for each tool:
    # 0. Selection (crosshair)
    draw.line([tool_xs[0] - 10, tb_cy, tool_xs[0] + 10, tb_cy], fill=tool_color, width=2)
    draw.line([tool_xs[0], tb_cy - 10, tool_xs[0], tb_cy + 10], fill=tool_color, width=2)
    draw.ellipse([tool_xs[0] - 6, tb_cy - 6, tool_xs[0] + 6, tb_cy + 6], outline=tool_color, width=2)
    
    # 1. Arrow (Active/Highlighted - drawn in white on blue background)
    draw.line([tool_xs[1] - 8, tb_cy + 6, tool_xs[1] + 8, tb_cy - 6], fill=(255, 255, 255, 255), width=3)
    draw.polygon([
        (tool_xs[1] + 8, tb_cy - 6),
        (tool_xs[1] + 1, tb_cy - 8),
        (tool_xs[1] + 9, tb_cy + 1),
    ], fill=(255, 255, 255, 255))
    
    # 2. Text (T)
    draw.line([tool_xs[2] - 8, tb_cy - 8, tool_xs[2] + 8, tb_cy - 8], fill=tool_color, width=2)
    draw.line([tool_xs[2], tb_cy - 8, tool_xs[2], tb_cy + 8], fill=tool_color, width=2)
    
    # 3. Blur (Pixel Grid)
    for bx in range(-6, 7, 4):
        for by in range(-6, 7, 4):
            draw.rectangle(
                [tool_xs[3] + bx - 1, tb_cy + by - 1, tool_xs[3] + bx + 1, tb_cy + by + 1],
                fill=tool_color
            )
            
    # 4. Crop Frame
    draw.rectangle([tool_xs[4] - 8, tb_cy - 8, tool_xs[4] + 8, tb_cy + 8], outline=tool_color, width=2)
    draw.line([tool_xs[4] - 12, tb_cy - 8, tool_xs[4] + 12, tb_cy - 8], fill=tool_color, width=1)
    draw.line([tool_xs[4] - 8, tb_cy - 12, tool_xs[4] - 8, tb_cy + 12], fill=tool_color, width=1)

    # 5. Settings / Gear
    draw.ellipse([tool_xs[5] - 8, tb_cy - 8, tool_xs[5] + 8, tb_cy + 8], outline=tool_color, width=2)
    draw.ellipse([tool_xs[5] - 3, tb_cy - 3, tool_xs[5] + 3, tb_cy + 3], fill=tool_color)
    for angle in range(0, 360, 45):
        rad = math.radians(angle)
        draw.line([
            (tool_xs[5] + math.cos(rad)*6, tb_cy + math.sin(rad)*6),
            (tool_xs[5] + math.cos(rad)*10, tb_cy + math.sin(rad)*10)
        ], fill=tool_color, width=2)

    # 4. Drag Path & Connection Arrow (Vibrant brand-blue arrow!)
    p_src = (360, 340)
    p_dest = (960, 340)
    
    curve_start = (p_src[0] + 140, p_src[1])
    curve_end = (p_dest[0] - 140, p_dest[1])
    curve_control = ((curve_start[0] + curve_end[0]) // 2, p_src[1] - 110)
    
    # Soft light blue glow effect
    base_img = draw_glow_effect(
        base_img, 
        curve_start, 
        curve_control, 
        curve_end, 
        color=(57, 95, 255, 40), # 15% opacity blue glow
        blur_radius=12
    )
    
    # Re-obtain Draw handle
    draw = ImageDraw.Draw(base_img)
    
    # Draw the sharp solid brand blue arrow line
    curve_pts = draw_bezier_curve(
        draw, 
        curve_start, 
        curve_control, 
        curve_end, 
        color=(57, 95, 255, 255), 
        width=5
    )
    
    d_x = curve_end[0] - curve_control[0]
    d_y = curve_end[1] - curve_control[1]
    angle_rad = math.atan2(d_y, d_x)
    
    # Draw arrow head
    draw_arrow_head(draw, curve_end, angle_rad, size=18, color=(57, 95, 255, 255))
    
    # 5. Glassmorphic Dropzones (Light theme)
    bg_glass = (255, 255, 255, 150)     # White glass frosted card
    border_glass = (255, 255, 255, 220) # Clean white border
    
    # Draw Left Dropzone (Cinderdeck App)
    draw_glass_card(base_img, p_src[0], p_src[1], 280, 280, 48, border_glass, bg_glass)
    # Draw a thin target dash-ring inside Cinderdeck card (soft blue)
    draw.ellipse(
        [p_src[0] - 100, p_src[1] - 100, p_src[0] + 100, p_src[1] + 100],
        outline=(57, 95, 255, 30),
        width=2
    )
    
    # Draw Right Dropzone (Applications Folder)
    draw_glass_card(base_img, p_dest[0], p_dest[1], 280, 280, 48, border_glass, bg_glass)
    # Draw target dash-ring inside Applications card (soft blue)
    draw.ellipse(
        [p_dest[0] - 100, p_dest[1] - 100, p_dest[0] + 100, p_dest[1] + 100],
        outline=(57, 95, 255, 30),
        width=2
    )
    
    # 6. Typography & Labels (Main Instruction at bottom)
    
    # Centered Main Instruction text at bottom (accent capsule with primary blue text!)
    ins_text = "Drag Cinderdeck to Applications folder to install"
    ins_w, ins_h = 520, 48
    ins_x0, ins_y0 = 660 - ins_w//2, 690
    draw.rounded_rectangle(
        [ins_x0, ins_y0, ins_x0 + ins_w, ins_y0 + ins_h],
        radius=24,
        fill=(57, 95, 255, 15), # 6% opacity brand blue
        outline=(57, 95, 255, 50), # 20% opacity brand blue border
        width=2
    )
    draw.text(
        (660, ins_y0 + ins_h//2 - 1),
        ins_text,
        fill=(57, 95, 255, 255), # Focal Point: Brand blue text!
        font=font_sub,
        anchor="mm"
    )
    
    # Small keyboard hint at the very bottom
    hint_text = "Press  ⌥⇧4  to capture  •  Open-source screen utility"
    draw.text((660, 765), hint_text, fill=(148, 163, 184, 255), font=font_desc, anchor="ma")

    # Save output image with 144 DPI for Retina support in macOS Finder
    base_img.save(OUTPUT_PATH, "PNG", dpi=(144, 144))
    print(f"DMG Background saved to: {OUTPUT_PATH}")

if __name__ == "__main__":
    main()
