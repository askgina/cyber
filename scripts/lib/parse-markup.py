"""Use stdlib parsers in the smoke checks; no browser or package dependencies."""
import json
import sys
from html.parser import HTMLParser
from xml.etree import ElementTree


class HTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []
        self.script = None

    def handle_starttag(self, tag, attrs):
        line, _ = self.getpos()
        entry = {"tag": tag, "attrs": dict(attrs), "line": line}
        self.tags.append(entry)
        if tag == "script":
            entry["body"] = ""
            self.script = entry

    def handle_data(self, data):
        if self.script is not None:
            self.script["body"] += data

    def handle_endtag(self, tag):
        if tag == "script" and self.script is not None:
            self.script["closed"] = True
            self.script = None


def xml(body):
    root = ElementTree.fromstring(body)
    bare = lambda tag: tag.rsplit("}", 1)[-1]
    return {
        "root": root.tag,
        "children": [bare(child.tag) for child in root],
        "locations": [node.text for node in root.iter() if bare(node.tag) == "loc"],
    }


source = sys.stdin.read()
if sys.argv[1] == "xml":
    print(json.dumps(xml(source)))
else:
    parser = HTML()
    parser.feed(source)
    parser.close()
    print(json.dumps(parser.tags))
