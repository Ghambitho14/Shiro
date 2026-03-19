from PIL import Image
import os

files = ["public/Shiro.PNG", "public/Shiro_chiquito.png"]
for name in files:
    if os.path.exists(name):
        with Image.open(name) as img:
            print(name, img.size, img.format, os.path.getsize(name))
    else:
        print(name, "missing")
